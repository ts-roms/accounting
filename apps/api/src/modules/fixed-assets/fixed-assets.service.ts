import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, ilike, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  CapitalizeAssetInput,
  CreateAssetCategoryInput,
  CreateAssetInput,
  DisposeAssetInput,
  FixedAssetSettingsInput,
  ImpairAssetInput,
  ListAssetsQuery,
  RevalueAssetInput,
  SplitAssetInput,
  TransferAssetInput,
  UpdateAssetCategoryInput,
  UpdateAssetInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  assetCategories,
  assetEvents,
  fixedAssetSettings,
  fixedAssets,
  journalEntries,
  type AssetCategory,
  type AssetEvent,
  type FixedAsset,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { bookValue, disposalGainLoss, monthlyDepreciation, schedule } from './depreciation';

const MODULE = 'FIXED_ASSETS';

export interface AssetView extends FixedAsset {
  categoryCode: string;
  categoryName: string;
  bookValue: string;
  capitalizationJournalNumber: string | null;
  disposalJournalNumber: string | null;
}

export interface AssetDetail extends AssetView {
  events: Array<AssetEvent & { journalNumber: string | null }>;
  nextDepreciation: string;
  remainingSchedule: string[];
}

export interface ResolvedAssetAccounts {
  asset: string;
  accumulated: string;
  expense: string;
}

/**
 * Asset register with its full lifecycle. Cost and accumulated depreciation on
 * the register must equal the asset / accumulated depreciation accounts:
 * every change here posts through the posting service in the same transaction.
 */
@Injectable()
export class FixedAssetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
  ) {}

  // -------------------------------------------------------------- categories

  async listCategories(companyId: string): Promise<Array<AssetCategory & { assetCount: number }>> {
    return this.db
      .select({
        ...getTableColumns(assetCategories),
        assetCount: sql<number>`(select count(*)::int from fixed_assets a where a.category_id = ${assetCategories.id})`,
      })
      .from(assetCategories)
      .where(eq(assetCategories.companyId, companyId))
      .orderBy(asc(assetCategories.code));
  }

  async createCategory(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateAssetCategoryInput,
  ): Promise<AssetCategory> {
    return this.db.transaction(async (tx) => {
      await this.assertAccounts(
        companyId,
        [
          input.assetAccountId,
          input.accumulatedDepreciationAccountId,
          input.depreciationExpenseAccountId,
        ],
        tx,
      );
      let row: AssetCategory | undefined;
      try {
        [row] = await tx
          .insert(assetCategories)
          .values({ companyId, ...input, code: input.code.toUpperCase() })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'asset_categories_company_code_uq'))
          throw new DuplicateError('Asset category', 'code', input.code);
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'AssetCategory',
          entityId: row!.id,
          newValue: { code: row!.code },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async updateCategory(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateAssetCategoryInput,
  ): Promise<AssetCategory> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(assetCategories)
        .where(and(eq(assetCategories.id, id), eq(assetCategories.companyId, companyId)));
      if (!existing) throw new NotFoundError('Asset category', id);
      await this.assertAccounts(
        companyId,
        [
          input.assetAccountId,
          input.accumulatedDepreciationAccountId,
          input.depreciationExpenseAccountId,
        ],
        tx,
      );
      const { code, ...rest } = input;
      const [row] = await tx
        .update(assetCategories)
        .set({ ...rest, ...(code ? { code: code.toUpperCase() } : {}) })
        .where(eq(assetCategories.id, id))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'AssetCategory',
          entityId: id,
          newValue: input,
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  // ------------------------------------------------------------------ assets

  async list(companyId: string, query: ListAssetsQuery): Promise<PaginatedResult<AssetView>> {
    const filters: SQL[] = [eq(fixedAssets.companyId, companyId)];
    if (query.status) filters.push(eq(fixedAssets.status, query.status));
    if (query.categoryId) filters.push(eq(fixedAssets.categoryId, query.categoryId));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(fixedAssets.assetNumber, term),
          ilike(fixedAssets.name, term),
          ilike(fixedAssets.serialNumber, term),
          ilike(fixedAssets.location, term),
        )!,
      );
    }
    const where = and(...filters);
    const direction = query.sortDir === 'desc' ? desc : asc;
    const sortColumn =
      query.sortBy === 'name'
        ? fixedAssets.name
        : query.sortBy === 'acquisitionDate'
          ? fixedAssets.acquisitionDate
          : fixedAssets.assetNumber;
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(direction(sortColumn))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(fixedAssets)
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<AssetDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(fixedAssets.id, id), eq(fixedAssets.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Fixed asset', id);
    const events = await this.db
      .select({ event: assetEvents, journalNumber: journalEntries.documentNumber })
      .from(assetEvents)
      .leftJoin(journalEntries, eq(journalEntries.id, assetEvents.journalEntryId))
      .where(eq(assetEvents.assetId, id))
      .orderBy(desc(assetEvents.eventDate), desc(assetEvents.createdAt));
    const active = row.status === 'ACTIVE';
    return {
      ...row,
      events: events.map((e) => ({ ...e.event, journalNumber: e.journalNumber })),
      nextDepreciation: active ? monthlyDepreciation(row, row.currency).toString() : '0.0000',
      remainingSchedule: active ? schedule(row, row.currency, 600).map((m) => m.toString()) : [],
    };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateAssetInput,
  ): Promise<AssetDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: fixedAssets.id })
          .from(fixedAssets)
          .where(
            and(
              eq(fixedAssets.companyId, companyId),
              eq(fixedAssets.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const category = await this.category(companyId, input.categoryId, tx);
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const cost = Money.parse(input.acquisitionCost, currency);
      const salvage = Money.parse(input.salvageValue, currency);
      if (!salvage.lessThan(cost))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Salvage value must be below the acquisition cost.',
        );
      const inService = input.inServiceDate ?? input.acquisitionDate;
      if (inService < input.acquisitionDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'In-service date cannot precede the acquisition date.',
        );
      const assetNumber = await this.numbering.allocate(
        companyId,
        'FA',
        Number(input.acquisitionDate.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(fixedAssets)
        .values({
          companyId,
          assetNumber,
          name: input.name,
          description: input.description ?? null,
          categoryId: category.id,
          acquisitionDate: input.acquisitionDate,
          inServiceDate: inService,
          acquisitionCost: cost.toString(),
          salvageValue: salvage.toString(),
          usefulLifeMonths: input.usefulLifeMonths ?? category.usefulLifeMonths,
          depreciationMethod: input.depreciationMethod ?? category.depreciationMethod,
          decliningRatePercent:
            input.decliningRatePercent === undefined
              ? category.decliningRatePercent
              : input.decliningRatePercent,
          cost: cost.toString(),
          location: input.location ?? null,
          branchId: input.branchId ?? null,
          serialNumber: input.serialNumber ?? null,
          vendorId: input.vendorId ?? null,
          reference: input.reference ?? null,
          currency,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'FixedAsset',
          entityId: created!.id,
          newValue: { assetNumber, name: input.name, cost: cost.toString() },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateAssetInput,
  ): Promise<AssetDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      const draft = existing.status === 'DRAFT';
      // Once capitalised only descriptive fields may change; cost and schedule are ledger facts.
      if (!draft) {
        for (const field of [
          'acquisitionCost',
          'salvageValue',
          'usefulLifeMonths',
          'depreciationMethod',
          'decliningRatePercent',
          'acquisitionDate',
          'inServiceDate',
          'categoryId',
        ] as const) {
          if (input[field] !== undefined)
            throw new BusinessRuleError(
              ErrorCodes.DOCUMENT_INVALID_STATE,
              `${field} cannot change after capitalisation.`,
            );
        }
      }
      const category = input.categoryId
        ? await this.category(companyId, input.categoryId, tx)
        : null;
      const cost = input.acquisitionCost
        ? Money.parse(input.acquisitionCost, existing.currency)
        : Money.of(existing.acquisitionCost, existing.currency);
      const salvage =
        input.salvageValue !== undefined
          ? Money.parse(input.salvageValue, existing.currency)
          : Money.of(existing.salvageValue, existing.currency);
      if (!salvage.lessThan(cost))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Salvage value must be below the acquisition cost.',
        );
      await tx
        .update(fixedAssets)
        .set({
          name: input.name ?? existing.name,
          description: input.description === undefined ? existing.description : input.description,
          categoryId: category?.id ?? existing.categoryId,
          acquisitionDate: input.acquisitionDate ?? existing.acquisitionDate,
          inServiceDate: input.inServiceDate ?? existing.inServiceDate,
          acquisitionCost: cost.toString(),
          cost: draft ? cost.toString() : existing.cost,
          salvageValue: salvage.toString(),
          usefulLifeMonths: input.usefulLifeMonths ?? existing.usefulLifeMonths,
          depreciationMethod: input.depreciationMethod ?? existing.depreciationMethod,
          decliningRatePercent:
            input.decliningRatePercent === undefined
              ? existing.decliningRatePercent
              : input.decliningRatePercent,
          location: input.location === undefined ? existing.location : input.location,
          branchId: input.branchId === undefined ? existing.branchId : input.branchId,
          serialNumber:
            input.serialNumber === undefined ? existing.serialNumber : input.serialNumber,
          vendorId: input.vendorId === undefined ? existing.vendorId : input.vendorId,
          reference: input.reference === undefined ? existing.reference : input.reference,
        })
        .where(eq(fixedAssets.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'FixedAsset',
          entityId: id,
          newValue: input,
          metadata: { assetNumber: existing.assetNumber, actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.assetNumber} is capitalised and cannot be deleted; dispose of it instead.`,
        );
      await tx.delete(fixedAssets).where(eq(fixedAssets.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'FixedAsset',
          entityId: id,
          previousValue: { assetNumber: existing.assetNumber },
          companyId,
        },
        tx,
      );
    });
  }

  /** Dr asset cost / Cr clearing (or the account given). The asset becomes ACTIVE and starts depreciating. */
  async capitalize(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: CapitalizeAssetInput,
  ): Promise<AssetDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.assetNumber} is already capitalised.`,
        );
      const accts = await this.resolveAccounts(companyId, existing.categoryId, tx);
      const credit = input.creditAccountId
        ? (await this.accounts.findByIds(companyId, [input.creditAccountId], tx))[0]
        : await this.accounts.resolveMapped(companyId, 'FIXED_ASSET_CLEARING', tx);
      if (!credit || credit.isHeader || credit.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          'The credit account is not postable.',
        );
      const postingDate = input.postingDate ?? existing.acquisitionDate;
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: postingDate,
          description: `Capitalise ${existing.assetNumber} ${existing.name}`,
          reference: existing.reference ?? existing.assetNumber,
          journalType: 'GENERAL',
          branchId: existing.branchId,
          sourceType: 'FIXED_ASSET_CAPITALIZATION',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: accts.asset,
              debit: existing.acquisitionCost,
              credit: '0',
              description: `${existing.assetNumber} acquisition cost`,
              branchId: existing.branchId,
            },
            {
              accountId: credit.id,
              debit: '0',
              credit: existing.acquisitionCost,
              description: `${existing.assetNumber} capitalised`,
              branchId: existing.branchId,
            },
          ],
        },
        { permission: P['fixed-asset.post'] },
      );
      await tx
        .update(fixedAssets)
        .set({
          status: 'ACTIVE',
          cost: existing.acquisitionCost,
          capitalizationJournalEntryId: entry.id,
          capitalizedAt: new Date(),
        })
        .where(eq(fixedAssets.id, id));
      await tx.insert(assetEvents).values({
        assetId: id,
        eventType: 'CAPITALIZATION',
        eventDate: postingDate,
        amount: existing.acquisitionCost,
        bookValueAfter: existing.acquisitionCost,
        journalEntryId: entry.id,
        notes: `Credited to ${credit.code} ${credit.name}`,
        createdBy: actor.id,
      });
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'FixedAsset',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'ACTIVE', journalEntryId: entry.id },
          metadata: { assetNumber: existing.assetNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Migrated asset at cut-over (hardening H6): registers it, capitalises the
   * cost against OPENING_BALANCE_EQUITY and books the depreciation already
   * taken (Dr opening equity / Cr accumulated) so the register, the cost account
   * and the accumulated account all agree with the legacy books. One
   * transaction; depreciation continues from the remaining life.
   */
  async openingBalance(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateAssetInput,
    accumulatedDepreciation: string,
    asOfDate: string,
  ): Promise<AssetDetail> {
    const created = await this.create(companyId, actor, input);
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, created.id);
      const equity = await this.accounts.resolveMapped(companyId, 'OPENING_BALANCE_EQUITY', tx);
      const accts = await this.resolveAccounts(companyId, existing.categoryId, tx);
      const currency = existing.currency;
      const cost = Money.of(existing.acquisitionCost, currency);
      const accumulated = Money.of(accumulatedDepreciation, currency);
      if (accumulated.isNegative() || !cost.greaterThan(accumulated))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Accumulated depreciation must be at least zero and below the cost.',
        );
      const capitalisation = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: asOfDate,
          description: `Opening balance ${existing.assetNumber} ${existing.name}`,
          reference: existing.reference ?? existing.assetNumber,
          journalType: 'OPENING',
          branchId: existing.branchId,
          sourceType: 'FIXED_ASSET_CAPITALIZATION',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: accts.asset,
              debit: cost.toString(),
              credit: '0',
              description: `${existing.assetNumber} cost at cut-over`,
              branchId: existing.branchId,
            },
            {
              accountId: equity.id,
              debit: '0',
              credit: cost.toString(),
              description: `${existing.assetNumber} opening balance offset`,
              branchId: existing.branchId,
            },
          ],
        },
        { permission: P['fixed-asset.post'] },
      );
      let depreciationEntryId: string | null = null;
      if (!accumulated.isZero()) {
        const entry = await this.posting.postEvent(
          tx,
          {
            companyId,
            entryDate: asOfDate,
            description: `Opening accumulated depreciation ${existing.assetNumber}`,
            reference: existing.reference ?? existing.assetNumber,
            journalType: 'OPENING',
            branchId: existing.branchId,
            sourceType: 'FIXED_ASSET_OPENING_DEPRECIATION',
            sourceId: existing.id,
            actor,
            lines: [
              {
                accountId: equity.id,
                debit: accumulated.toString(),
                credit: '0',
                description: `${existing.assetNumber} depreciation taken before cut-over`,
                branchId: existing.branchId,
              },
              {
                accountId: accts.accumulated,
                debit: '0',
                credit: accumulated.toString(),
                description: `${existing.assetNumber} accumulated depreciation at cut-over`,
                branchId: existing.branchId,
              },
            ],
          },
          { permission: P['fixed-asset.post'] },
        );
        depreciationEntryId = entry.id;
      }
      await tx
        .update(fixedAssets)
        .set({
          status: 'ACTIVE',
          cost: cost.toString(),
          accumulatedDepreciation: accumulated.toString(),
          capitalizationJournalEntryId: capitalisation.id,
          capitalizedAt: new Date(),
        })
        .where(eq(fixedAssets.id, existing.id));
      await tx.insert(assetEvents).values({
        assetId: existing.id,
        eventType: 'CAPITALIZATION',
        eventDate: asOfDate,
        amount: cost.toString(),
        bookValueAfter: cost.subtract(accumulated).toString(),
        journalEntryId: capitalisation.id,
        notes: `Opening balance credited to ${equity.code} ${equity.name}`,
        createdBy: actor.id,
      });
      if (depreciationEntryId) {
        await tx.insert(assetEvents).values({
          assetId: existing.id,
          eventType: 'DEPRECIATION',
          eventDate: asOfDate,
          amount: accumulated.toString(),
          bookValueAfter: cost.subtract(accumulated).toString(),
          journalEntryId: depreciationEntryId,
          notes: 'Accumulated depreciation before cut-over',
          createdBy: actor.id,
        });
      }
      await this.audit.record(
        {
          action: 'OPENING_BALANCE',
          module: MODULE,
          entityType: 'FixedAsset',
          entityId: existing.id,
          newValue: {
            assetNumber: existing.assetNumber,
            cost: cost.toString(),
            accumulatedDepreciation: accumulated.toString(),
            asOfDate,
          },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, created.id);
  }

  /** Location / branch change - recorded, no ledger effect. */
  async transfer(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: TransferAssetInput,
  ): Promise<AssetDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertCarried(existing);
      await tx
        .update(fixedAssets)
        .set({
          location: input.location === undefined ? existing.location : input.location,
          branchId: input.branchId === undefined ? existing.branchId : input.branchId,
        })
        .where(eq(fixedAssets.id, id));
      await tx.insert(assetEvents).values({
        assetId: id,
        eventType: 'TRANSFER',
        eventDate: input.eventDate,
        amount: '0',
        bookValueAfter: bookValue(existing, existing.currency).toString(),
        notes: `${existing.location ?? '-'} -> ${input.location ?? existing.location ?? '-'}${input.notes ? ` - ${input.notes}` : ''}`,
        createdBy: actor.id,
      });
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'FixedAsset',
          entityId: id,
          previousValue: { location: existing.location, branchId: existing.branchId },
          newValue: { location: input.location, branchId: input.branchId },
          metadata: { assetNumber: existing.assetNumber, event: 'TRANSFER' },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Dr impairment loss / Cr accumulated depreciation. Future depreciation spreads the new book value over the remaining life. */
  async impair(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: ImpairAssetInput,
  ): Promise<AssetDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertCarried(existing);
      const currency = existing.currency;
      const amount = Money.parse(input.amount, currency);
      const bv = bookValue(existing, currency);
      const floor = Money.of(existing.salvageValue, currency);
      if (amount.greaterThan(bv.subtract(floor))) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `Impairment cannot take the book value below the salvage value (max ${bv.subtract(floor).toString()}).`,
        );
      }
      const accts = await this.resolveAccounts(companyId, existing.categoryId, tx);
      const loss = await this.accounts.resolveMapped(companyId, 'IMPAIRMENT_LOSS', tx);
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.eventDate,
          description: `Impairment ${existing.assetNumber} ${existing.name}${input.notes ? ` - ${input.notes}` : ''}`,
          reference: existing.assetNumber,
          journalType: 'ADJUSTING',
          branchId: existing.branchId,
          sourceType: 'FIXED_ASSET_IMPAIRMENT',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: loss.id,
              debit: amount.toString(),
              credit: '0',
              description: `${existing.assetNumber} impairment loss`,
              branchId: existing.branchId,
            },
            {
              accountId: accts.accumulated,
              debit: '0',
              credit: amount.toString(),
              description: `${existing.assetNumber} accumulated impairment`,
              branchId: existing.branchId,
            },
          ],
        },
        { permission: P['fixed-asset.post'] },
      );
      const accumulated = Money.of(existing.accumulatedDepreciation, currency).add(amount);
      const after = bv.subtract(amount);
      await tx
        .update(fixedAssets)
        .set({
          accumulatedDepreciation: accumulated.toString(),
          status: after.equals(floor) ? 'FULLY_DEPRECIATED' : existing.status,
        })
        .where(eq(fixedAssets.id, id));
      await tx.insert(assetEvents).values({
        assetId: id,
        eventType: 'IMPAIRMENT',
        eventDate: input.eventDate,
        amount: amount.toString(),
        bookValueAfter: after.toString(),
        journalEntryId: entry.id,
        notes: input.notes ?? null,
        createdBy: actor.id,
      });
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'FixedAsset',
          entityId: id,
          newValue: { event: 'IMPAIRMENT', amount: amount.toString(), journalEntryId: entry.id },
          metadata: { assetNumber: existing.assetNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Upward revaluation: Dr asset cost / Cr revaluation surplus (equity). */
  async revalue(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: RevalueAssetInput,
  ): Promise<AssetDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertCarried(existing);
      const currency = existing.currency;
      const target = Money.parse(input.newBookValue, currency);
      const bv = bookValue(existing, currency);
      if (!target.greaterThan(bv))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Revaluation must increase the book value; use impairment to reduce it.',
        );
      const increase = target.subtract(bv);
      const accts = await this.resolveAccounts(companyId, existing.categoryId, tx);
      const surplus = await this.accounts.resolveMapped(companyId, 'REVALUATION_SURPLUS', tx);
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.eventDate,
          description: `Revaluation ${existing.assetNumber} ${existing.name}${input.notes ? ` - ${input.notes}` : ''}`,
          reference: existing.assetNumber,
          journalType: 'ADJUSTING',
          branchId: existing.branchId,
          sourceType: 'FIXED_ASSET_REVALUATION',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: accts.asset,
              debit: increase.toString(),
              credit: '0',
              description: `${existing.assetNumber} revaluation`,
              branchId: existing.branchId,
            },
            {
              accountId: surplus.id,
              debit: '0',
              credit: increase.toString(),
              description: `${existing.assetNumber} revaluation surplus`,
              branchId: existing.branchId,
            },
          ],
        },
        { permission: P['fixed-asset.post'] },
      );
      await tx
        .update(fixedAssets)
        .set({ cost: Money.of(existing.cost, currency).add(increase).toString(), status: 'ACTIVE' })
        .where(eq(fixedAssets.id, id));
      await tx.insert(assetEvents).values({
        assetId: id,
        eventType: 'REVALUATION',
        eventDate: input.eventDate,
        amount: increase.toString(),
        bookValueAfter: target.toString(),
        journalEntryId: entry.id,
        notes: input.notes ?? null,
        createdBy: actor.id,
      });
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'FixedAsset',
          entityId: id,
          newValue: { event: 'REVALUATION', amount: increase.toString(), journalEntryId: entry.id },
          metadata: { assetNumber: existing.assetNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Disposal / write-off: Dr accumulated depreciation, Dr proceeds account,
   * Cr asset cost, gain or loss to the disposal account.
   */
  async dispose(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: DisposeAssetInput,
  ): Promise<AssetDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertCarried(existing);
      const currency = existing.currency;
      const proceeds = Money.parse(input.proceeds, currency);
      if (proceeds.isPositive() && !input.proceedsAccountId)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Choose the account receiving the proceeds.',
        );
      const accts = await this.resolveAccounts(companyId, existing.categoryId, tx);
      const gainLoss = await this.accounts.resolveMapped(companyId, 'GAIN_LOSS_ON_DISPOSAL', tx);
      const result = disposalGainLoss(existing, proceeds.toString(), currency);
      const lines = [
        {
          accountId: accts.accumulated,
          debit: existing.accumulatedDepreciation,
          credit: '0',
          description: `${existing.assetNumber} accumulated depreciation released`,
          branchId: existing.branchId,
        },
        {
          accountId: accts.asset,
          debit: '0',
          credit: existing.cost,
          description: `${existing.assetNumber} cost derecognised`,
          branchId: existing.branchId,
        },
      ];
      if (proceeds.isPositive())
        lines.push({
          accountId: input.proceedsAccountId!,
          debit: proceeds.toString(),
          credit: '0',
          description: `${existing.assetNumber} disposal proceeds`,
          branchId: existing.branchId,
        });
      if (!result.isZero()) {
        lines.push({
          accountId: gainLoss.id,
          debit: result.isNegative() ? result.abs().toString() : '0',
          credit: result.isPositive() ? result.toString() : '0',
          description: `${existing.assetNumber} ${result.isPositive() ? 'gain' : 'loss'} on disposal`,
          branchId: existing.branchId,
        });
      }
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.eventDate,
          description: `${proceeds.isPositive() ? 'Disposal' : 'Write-off'} ${existing.assetNumber} ${existing.name}${input.notes ? ` - ${input.notes}` : ''}`,
          reference: existing.assetNumber,
          journalType: 'GENERAL',
          branchId: existing.branchId,
          sourceType: 'FIXED_ASSET_DISPOSAL',
          sourceId: existing.id,
          actor,
          lines: lines.filter((l) => Number(l.debit) !== 0 || Number(l.credit) !== 0),
        },
        { permission: P['fixed-asset.post'] },
      );
      const status = proceeds.isPositive() ? 'DISPOSED' : 'WRITTEN_OFF';
      await tx
        .update(fixedAssets)
        .set({
          status,
          disposalDate: input.eventDate,
          disposalProceeds: proceeds.toString(),
          disposalGainLoss: result.toString(),
          disposalJournalEntryId: entry.id,
        })
        .where(eq(fixedAssets.id, id));
      await tx.insert(assetEvents).values({
        assetId: id,
        eventType: proceeds.isPositive() ? 'DISPOSAL' : 'WRITE_OFF',
        eventDate: input.eventDate,
        amount: Money.of(existing.cost, currency).negate().toString(),
        bookValueAfter: '0',
        journalEntryId: entry.id,
        notes:
          `${input.notes ?? ''} proceeds ${proceeds.toString()}, ${result.isNegative() ? 'loss' : 'gain'} ${result.abs().toString()}`.trim(),
        createdBy: actor.id,
      });
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'FixedAsset',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: {
            status,
            proceeds: proceeds.toString(),
            gainLoss: result.toString(),
            journalEntryId: entry.id,
          },
          metadata: { assetNumber: existing.assetNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Split (Prompt #13): carve the asset into child assets that each take a
   * share of cost, accumulated depreciation and salvage value; the parent
   * keeps the remainder, or leaves the register (DISPOSED, nothing released
   * to profit) when the parts add up to 100%. Register only - every child
   * uses the parent's accounts, so the ledger does not move and nothing
   * posts. Children continue the parent's depreciation clock.
   */
  async split(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: SplitAssetInput,
  ): Promise<{ parent: AssetDetail; children: AssetDetail[] }> {
    const childIds = await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertCarried(existing);
      if (input.eventDate < existing.inServiceDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The split date cannot precede the in-service date.',
        );
      const currency = existing.currency;
      // Percentages carry up to four decimals: scale to integers for an exact allocation.
      const ratios = input.parts.map((p) => Math.round(Number(p.percent) * 10000));
      const totalRatio = ratios.reduce((a, b) => a + b, 0);
      if (totalRatio > 1_000_000)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The parts add up to more than 100% of the asset.',
        );
      const remainder = 1_000_000 - totalRatio;
      const weights = remainder > 0 ? [...ratios, remainder] : ratios;
      const cost = Money.of(existing.cost, currency).allocate(weights);
      const acquisition = Money.of(existing.acquisitionCost, currency).allocate(weights);
      const accumulated = Money.of(existing.accumulatedDepreciation, currency).allocate(weights);
      const salvage = Money.of(existing.salvageValue, currency).allocate(weights);
      const year = Number(input.eventDate.slice(0, 4));
      const ids: string[] = [];
      const created: string[] = [];
      for (let i = 0; i < input.parts.length; i += 1) {
        const part = input.parts[i]!;
        if (cost[i]!.isZero() || acquisition[i]!.isZero())
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            `Part "${part.name}" would carry no cost.`,
          );
        const assetNumber = await this.numbering.allocate(companyId, 'FA', year, tx);
        const [child] = await tx
          .insert(fixedAssets)
          .values({
            companyId,
            assetNumber,
            name: part.name,
            description: `Split from ${existing.assetNumber} ${existing.name} (${Number(part.percent)}%)`,
            categoryId: existing.categoryId,
            status: existing.status,
            acquisitionDate: existing.acquisitionDate,
            inServiceDate: existing.inServiceDate,
            acquisitionCost: acquisition[i]!.toString(),
            salvageValue: salvage[i]!.toString(),
            usefulLifeMonths: existing.usefulLifeMonths,
            depreciationMethod: existing.depreciationMethod,
            decliningRatePercent: existing.decliningRatePercent,
            cost: cost[i]!.toString(),
            accumulatedDepreciation: accumulated[i]!.toString(),
            depreciatedMonths: existing.depreciatedMonths,
            location: part.location ?? existing.location,
            branchId: existing.branchId,
            serialNumber: part.serialNumber ?? null,
            vendorId: existing.vendorId,
            reference: existing.reference,
            currency,
            capitalizationJournalEntryId: existing.capitalizationJournalEntryId,
            capitalizedAt: existing.capitalizedAt,
            createdBy: actor.id,
          })
          .returning({ id: fixedAssets.id });
        ids.push(child!.id);
        created.push(assetNumber);
        await tx.insert(assetEvents).values({
          assetId: child!.id,
          eventType: 'SPLIT',
          eventDate: input.eventDate,
          amount: cost[i]!.toString(),
          bookValueAfter: cost[i]!.subtract(accumulated[i]!).toString(),
          notes: `From ${existing.assetNumber} (${Number(part.percent)}%)${input.notes ? ` - ${input.notes}` : ''}`,
          createdBy: actor.id,
        });
      }
      const keepIndex = input.parts.length;
      const parentCost = remainder > 0 ? cost[keepIndex]! : Money.zero(currency);
      const parentAccumulated = remainder > 0 ? accumulated[keepIndex]! : Money.zero(currency);
      const parentSalvage = remainder > 0 ? salvage[keepIndex]! : Money.zero(currency);
      const carvedOut = Money.of(existing.cost, currency).subtract(parentCost);
      await tx
        .update(fixedAssets)
        .set(
          remainder > 0
            ? {
                cost: parentCost.toString(),
                accumulatedDepreciation: parentAccumulated.toString(),
                salvageValue: parentSalvage.toString(),
              }
            : {
                cost: '0',
                accumulatedDepreciation: '0',
                salvageValue: '0',
                status: 'DISPOSED',
                disposalDate: input.eventDate,
                disposalProceeds: '0',
                disposalGainLoss: '0',
              },
        )
        .where(eq(fixedAssets.id, id));
      await tx.insert(assetEvents).values({
        assetId: id,
        eventType: 'SPLIT',
        eventDate: input.eventDate,
        amount: carvedOut.negate().toString(),
        bookValueAfter: parentCost.subtract(parentAccumulated).toString(),
        notes: `Split into ${created.join(', ')}${remainder > 0 ? '' : ' (fully split)'}${input.notes ? ` - ${input.notes}` : ''}`,
        createdBy: actor.id,
      });
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'FixedAsset',
          entityId: id,
          previousValue: {
            cost: existing.cost,
            accumulatedDepreciation: existing.accumulatedDepreciation,
            status: existing.status,
          },
          newValue: {
            cost: parentCost.toString(),
            accumulatedDepreciation: parentAccumulated.toString(),
            status: remainder > 0 ? existing.status : 'DISPOSED',
            children: created,
          },
          metadata: {
            reason: input.notes ?? 'Asset split',
            assetNumber: existing.assetNumber,
            event: 'SPLIT',
          },
          companyId,
        },
        tx,
      );
      return ids;
    });
    const parent = await this.get(companyId, id);
    const children = await Promise.all(childIds.map((c) => this.get(companyId, c)));
    return { parent, children };
  }

  // ---------------------------------------------------------------- settings

  async settings(companyId: string, executor: DbExecutor = this.db) {
    const [row] = await executor
      .select()
      .from(fixedAssetSettings)
      .where(eq(fixedAssetSettings.companyId, companyId));
    return (
      row ?? {
        companyId,
        autoPostDepreciation: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
    );
  }

  async updateSettings(
    companyId: string,
    actor: AuthenticatedUser,
    input: FixedAssetSettingsInput,
  ) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(fixedAssetSettings)
        .values({ companyId, ...input })
        .onConflictDoUpdate({ target: fixedAssetSettings.companyId, set: { ...input } })
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'FixedAssetSettings',
          entityId: companyId,
          newValue: input,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  // ----------------------------------------------------------------- helpers

  /** Category override -> company mapping for the three asset accounts. */
  async resolveAccounts(
    companyId: string,
    categoryId: string,
    tx: DbExecutor,
  ): Promise<ResolvedAssetAccounts> {
    const category = await this.category(companyId, categoryId, tx);
    const mapped = async (
      key: 'FIXED_ASSET_COST' | 'ACCUMULATED_DEPRECIATION' | 'DEPRECIATION_EXPENSE',
    ) => (await this.accounts.resolveMapped(companyId, key, tx)).id;
    return {
      asset: category.assetAccountId ?? (await mapped('FIXED_ASSET_COST')),
      accumulated:
        category.accumulatedDepreciationAccountId ?? (await mapped('ACCUMULATED_DEPRECIATION')),
      expense: category.depreciationExpenseAccountId ?? (await mapped('DEPRECIATION_EXPENSE')),
    };
  }

  async lock(tx: DbExecutor, companyId: string, id: string): Promise<FixedAsset> {
    const [row] = await tx
      .select()
      .from(fixedAssets)
      .where(and(eq(fixedAssets.id, id), eq(fixedAssets.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Fixed asset', id);
    return row;
  }

  private assertCarried(asset: FixedAsset): void {
    if (asset.status !== 'ACTIVE' && asset.status !== 'FULLY_DEPRECIATED') {
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${asset.assetNumber} is ${asset.status}; only capitalised assets can be changed.`,
        { status: asset.status },
      );
    }
  }

  private async category(companyId: string, id: string, tx: DbExecutor): Promise<AssetCategory> {
    const [row] = await tx
      .select()
      .from(assetCategories)
      .where(and(eq(assetCategories.id, id), eq(assetCategories.companyId, companyId)));
    if (!row) throw new NotFoundError('Asset category', id);
    if (row.status !== 'ACTIVE')
      throw new BusinessRuleError(ErrorCodes.PARTY_INACTIVE, `Category ${row.code} is inactive.`);
    return row;
  }

  private async assertAccounts(
    companyId: string,
    ids: Array<string | null | undefined>,
    tx: DbExecutor,
  ): Promise<void> {
    const wanted = ids.filter((x): x is string => Boolean(x));
    if (wanted.length === 0) return;
    const rows = await this.accounts.findByIds(companyId, [...new Set(wanted)], tx);
    const byId = new Map(rows.map((a) => [a.id, a]));
    for (const id of wanted) {
      const account = byId.get(id);
      if (!account)
        throw new BusinessRuleError(ErrorCodes.NOT_FOUND, 'An account override does not exist.');
      if (account.isHeader || account.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${account.code} ${account.name} cannot be used for postings.`,
        );
    }
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(fixedAssets),
        categoryCode: assetCategories.code,
        categoryName: assetCategories.name,
        bookValue: sql<string>`${fixedAssets.cost} - ${fixedAssets.accumulatedDepreciation}`,
        capitalizationJournalNumber: sql<
          string | null
        >`(select je.document_number from journal_entries je where je.id = ${fixedAssets.capitalizationJournalEntryId})`,
        disposalJournalNumber: sql<
          string | null
        >`(select je.document_number from journal_entries je where je.id = ${fixedAssets.disposalJournalEntryId})`,
      })
      .from(fixedAssets)
      .innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
      .$dynamic();
  }
}
