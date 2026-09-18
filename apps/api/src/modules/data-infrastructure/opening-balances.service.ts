import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { LEDGER_STATUSES, type OpeningBalanceArea } from '@accounting/types';
import type {
  OpeningAssetsInput,
  OpeningInventoryInput,
  OpeningSubledgerInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database } from '@/database/database.types';
import { customers, journalEntries, vendors } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { AuditService } from '@/modules/audit/audit.service';
import { FixedAssetsService } from '@/modules/fixed-assets/fixed-assets.service';
import { StockDocumentsService } from '@/modules/inventory/stock-documents.service';
import { BillsService } from '@/modules/payables/bills.service';
import { InvoicesService } from '@/modules/receivables/invoices.service';
import { SubledgerBalancesService } from '@/modules/reconciliation/subledger-balances.service';
import { ReportingService } from '@/modules/reporting/reporting.service';

const MODULE = 'DATA_INFRASTRUCTURE';

export interface OpeningLoadResult {
  area: OpeningBalanceArea;
  asOfDate: string;
  created: number;
  total: string;
  documents: string[];
}

export interface OpeningAreaReconciliation {
  area: OpeningBalanceArea;
  controlAccountId: string;
  /** Subledger detail as of the date (open items, stock value, register). */
  subledger: string;
  /** Control account balance as of the date. */
  ledger: string;
  variance: string;
  reconciled: boolean;
}

export interface OpeningBalanceReport {
  asOf: string;
  currency: string;
  areas: OpeningAreaReconciliation[];
  /** OPENING journals dated on or before the cut-over. */
  openingJournals: { count: number; posted: number; drafts: number; totalDebit: string };
  /** Balance left in OPENING_BALANCE_EQUITY: zero once every area is loaded and the equity itself was booked. */
  openingEquity: { accountId: string; code: string; balance: string };
  trialBalanceBalanced: boolean;
  reconciled: boolean;
}

/**
 * Controlled opening-balance process (hardening phase 6). General-ledger
 * balances arrive as one OPENING journal (`JournalEntriesService.openingBalances`,
 * also fed by the import engine); this service loads the subledgers so that
 * each control account is backed by real open items at the cut-over:
 * - AR / AP: one posted invoice / bill per legacy open item, its single line
 *   booked to OPENING_BALANCE_EQUITY (Dr AR / Cr equity, Dr equity / Cr AP);
 * - inventory: a posted stock adjustment with reason OPENING (Dr inventory / Cr equity);
 * - fixed assets: registered, capitalised and their accumulated depreciation
 *   booked against equity (`FixedAssetsService.openingBalance`).
 * The reconciliation report proves the result: every control account equals
 * its subledger and OPENING_BALANCE_EQUITY nets to zero once equity is loaded.
 */
@Injectable()
export class OpeningBalancesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly ledger: GeneralLedgerService,
    private readonly invoices: InvoicesService,
    private readonly bills: BillsService,
    private readonly stock: StockDocumentsService,
    private readonly assets: FixedAssetsService,
    private readonly balances: SubledgerBalancesService,
    private readonly reporting: ReportingService,
  ) {}

  /** AR / AP open items at cut-over, each posted against opening equity. */
  async loadSubledger(
    companyId: string,
    actor: AuthenticatedUser,
    input: OpeningSubledgerInput,
  ): Promise<OpeningLoadResult> {
    const currency = await this.accounts.companyCurrency(companyId);
    const equity = await this.accounts.resolveMapped(companyId, 'OPENING_BALANCE_EQUITY');
    // Validate everything before creating anything: parties must exist and be active,
    // dates must not be after the cut-over.
    const partyTable = input.area === 'AR' ? customers : vendors;
    const ids = [...new Set(input.items.map((i) => i.partyId))];
    const parties = await this.db
      .select({ id: partyTable.id, status: partyTable.status, code: partyTable.code })
      .from(partyTable)
      .where(and(eq(partyTable.companyId, companyId), inArray(partyTable.id, ids)));
    const byId = new Map(parties.map((p) => [p.id, p]));
    const problems: string[] = [];
    input.items.forEach((item, i) => {
      const party = byId.get(item.partyId);
      if (!party)
        problems.push(`item ${i + 1}: unknown ${input.area === 'AR' ? 'customer' : 'vendor'}`);
      else if (party.status !== 'ACTIVE') problems.push(`item ${i + 1}: ${party.code} is inactive`);
      if (item.documentDate > input.asOfDate)
        problems.push(`item ${i + 1}: document date is after the cut-over date`);
    });
    if (problems.length > 0)
      throw new BusinessRuleError(
        ErrorCodes.OPENING_BALANCE_INVALID,
        'The opening items are not valid.',
        { problems },
      );
    const documents: string[] = [];
    let total = Money.zero(currency);
    for (const [i, item] of input.items.entries()) {
      const idempotencyKey = input.idempotencyKey ? `${input.idempotencyKey}-${i + 1}` : undefined;
      const body = {
        documentType: 'INVOICE' as const,
        documentDate: item.documentDate,
        dueDate: item.dueDate ?? item.documentDate,
        reference: item.reference,
        description: item.description ?? `Opening balance ${item.reference}`,
        branchId: input.branchId ?? null,
        lines: [
          {
            description: item.description ?? `Opening balance ${item.reference}`,
            quantity: '1',
            unitPrice: item.amount,
            accountId: equity.id,
          },
        ],
        idempotencyKey,
      };
      const created =
        input.area === 'AR'
          ? await this.invoices.create(companyId, actor, {
              ...body,
              customerId: item.partyId,
            } as never)
          : await this.bills.create(companyId, actor, { ...body, vendorId: item.partyId } as never);
      if (created.status === 'DRAFT') {
        if (input.area === 'AR') await this.invoices.approve(companyId, actor, created.id);
        else await this.bills.approve(companyId, actor, created.id);
      }
      if (created.accountingStatus !== 'POSTED') {
        if (input.area === 'AR') await this.invoices.post(companyId, actor, created.id);
        else await this.bills.post(companyId, actor, created.id);
      }
      documents.push(created.documentNumber);
      total = total.add(Money.of(item.amount, currency));
    }
    await this.audit.record({
      action: 'OPENING_BALANCE',
      module: MODULE,
      entityType: input.area === 'AR' ? 'Invoice' : 'VendorBill',
      newValue: {
        area: input.area,
        asOfDate: input.asOfDate,
        items: documents.length,
        total: total.toString(),
      },
      metadata: { actor: actor.email },
      companyId,
    });
    return {
      area: input.area,
      asOfDate: input.asOfDate,
      created: documents.length,
      total: total.toString(),
      documents,
    };
  }

  /** Opening stock: one posted adjustment (reason OPENING) per warehouse. */
  async loadInventory(
    companyId: string,
    actor: AuthenticatedUser,
    input: OpeningInventoryInput,
  ): Promise<OpeningLoadResult> {
    const currency = await this.accounts.companyCurrency(companyId);
    const byWarehouse = new Map<string, typeof input.lines>();
    for (const line of input.lines)
      byWarehouse.set(line.warehouseId, [...(byWarehouse.get(line.warehouseId) ?? []), line]);
    const documents: string[] = [];
    let total = Money.zero(currency);
    let n = 0;
    for (const [warehouseId, lines] of byWarehouse) {
      n += 1;
      const draft = await this.stock.createAdjustment(companyId, actor, {
        warehouseId,
        documentDate: input.asOfDate,
        reason: 'OPENING',
        reference: 'Opening stock',
        notes: 'Opening balances at cut-over',
        lines: lines.map((l) => ({
          productId: l.productId,
          direction: 'IN' as const,
          quantity: l.quantity,
          unitCost: l.unitCost,
          lotNumber: l.lotNumber ?? undefined,
        })),
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}-${n}` : undefined,
      } as never);
      const posted =
        draft.status === 'POSTED'
          ? draft
          : await this.stock.post(companyId, actor, 'ADJUSTMENT', draft.id);
      documents.push(posted.documentNumber);
      total = total.add(Money.of(posted.totalCost ?? '0', currency));
    }
    await this.audit.record({
      action: 'OPENING_BALANCE',
      module: MODULE,
      entityType: 'StockDocument',
      newValue: { area: 'INVENTORY', asOfDate: input.asOfDate, documents, total: total.toString() },
      metadata: { actor: actor.email },
      companyId,
    });
    return {
      area: 'INVENTORY',
      asOfDate: input.asOfDate,
      created: documents.length,
      total: total.toString(),
      documents,
    };
  }

  /** Migrated assets with the depreciation already taken. */
  async loadAssets(
    companyId: string,
    actor: AuthenticatedUser,
    input: OpeningAssetsInput,
  ): Promise<OpeningLoadResult> {
    const currency = await this.accounts.companyCurrency(companyId);
    const documents: string[] = [];
    let total = Money.zero(currency);
    for (const [i, a] of input.assets.entries()) {
      const detail = await this.assets.openingBalance(
        companyId,
        actor,
        {
          name: a.name,
          categoryId: a.categoryId,
          acquisitionDate: a.acquisitionDate,
          inServiceDate: a.inServiceDate ?? a.acquisitionDate,
          acquisitionCost: a.acquisitionCost,
          salvageValue: a.salvageValue,
          usefulLifeMonths: a.usefulLifeMonths,
          reference: a.reference,
          serialNumber: a.serialNumber,
          branchId: input.branchId ?? null,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}-${i + 1}` : undefined,
        } as never,
        a.accumulatedDepreciation,
        input.asOfDate,
      );
      documents.push(detail.assetNumber);
      total = total
        .add(Money.of(a.acquisitionCost, currency))
        .subtract(Money.of(a.accumulatedDepreciation, currency));
    }
    return {
      area: 'FIXED_ASSETS',
      asOfDate: input.asOfDate,
      created: documents.length,
      total: total.toString(),
      documents,
    };
  }

  /** Every control account against its subledger at the cut-over, plus the opening equity residual. */
  async report(
    companyId: string,
    asOf: string,
    only?: OpeningBalanceArea,
  ): Promise<OpeningBalanceReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const areas: OpeningBalanceArea[] = only ? [only] : ['AR', 'AP', 'INVENTORY', 'FIXED_ASSETS'];
    const reconciliations: OpeningAreaReconciliation[] = [];
    for (const area of areas) {
      const b = await this.balances.compute(companyId, area, asOf);
      reconciliations.push({
        area,
        controlAccountId: b.controlAccountId,
        subledger: b.expected,
        ledger: b.actual,
        variance: b.variance,
        reconciled: Money.of(b.variance, currency).isZero(),
      });
    }
    const equity = await this.accounts.resolveMapped(companyId, 'OPENING_BALANCE_EQUITY');
    const activity = await this.ledger.activity({ companyId, to: asOf, accountIds: [equity.id] });
    const eqRow = activity.find((a) => a.accountId === equity.id);
    const equityBalance = Money.of(eqRow?.credit ?? '0', currency).subtract(
      Money.of(eqRow?.debit ?? '0', currency),
    );
    const opening = await this.db
      .select({ status: journalEntries.status, totalDebit: journalEntries.totalDebit })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          eq(journalEntries.journalType, 'OPENING'),
          lte(journalEntries.entryDate, asOf),
        ),
      );
    const posted = opening.filter((j) => (LEDGER_STATUSES as readonly string[]).includes(j.status));
    const tb = await this.reporting.trialBalance(companyId, {
      from: `${asOf.slice(0, 4)}-01-01`,
      to: asOf,
      includeZero: false,
    });
    return {
      asOf,
      currency,
      areas: reconciliations,
      openingJournals: {
        count: opening.length,
        posted: posted.length,
        drafts: opening.length - posted.length,
        totalDebit: posted
          .reduce((sum, j) => sum.add(Money.of(j.totalDebit, currency)), Money.zero(currency))
          .toString(),
      },
      openingEquity: { accountId: equity.id, code: equity.code, balance: equityBalance.toString() },
      trialBalanceBalanced: tb.balanced,
      reconciled: reconciliations.every((r) => r.reconciled) && tb.balanced,
    };
  }
}
