import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type { CreateApAccrualInput, GrniQuery, ListApAccrualsQuery } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  apAccrualLines,
  apAccruals,
  journalEntries,
  journalLines,
  orderLines,
  orders,
  vendors,
  type ApAccrual,
  type ApAccrualLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { DimensionsService } from '@/modules/accounting/dimensions/dimensions.service';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { ApConfigService } from './ap-config.service';
import { grniValue } from './payables.logic';

const MODULE = 'PAYABLES';

export interface GrniRow {
  orderId: string;
  orderNumber: string;
  orderLineId: string;
  lineNumber: number;
  description: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  productId: string | null;
  /** Stocked lines were posted to inventory / GRNI at receipt; service lines await an accrual. */
  stocked: boolean;
  accountId: string;
  accountCode: string;
  receivedQuantity: string;
  billedQuantity: string;
  openQuantity: string;
  unitPrice: string;
  amount: string;
  currency: string;
  lastReceiptDate: string | null;
  ageDays: number;
  aged: boolean;
}

export interface GrniReport {
  asOf: string;
  currency: string;
  rows: GrniRow[];
  totals: {
    stocked: string;
    unstocked: string;
    total: string;
    aged: string;
    lines: number;
  };
  /** Balance of the GOODS_RECEIVED_NOT_INVOICED account on asOf, for reconciliation with `totals.stocked`. */
  grniAccountBalance: string;
  difference: string;
}

export interface ApAccrualDetail extends ApAccrual {
  journalNumber: string | null;
  lines: Array<ApAccrualLine & { accountCode: string; vendorName: string | null }>;
}

/**
 * Received-not-billed analysis and period-end AP accruals (Prompt #7).
 * Stocked receipts already sit in the GRNI clearing account; service and
 * expense receipts do not, so a RECEIVED_NOT_BILLED accrual posts
 * Dr expense / Cr accrued expense for them on the period end and reverses on
 * the first day of the next period. Manual accruals cover contracts without
 * a purchase order. Every posting goes through the gateway.
 */
@Injectable()
export class ApAccrualsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly dimensions: DimensionsService,
    private readonly outbox: OutboxService,
    private readonly config: ApConfigService,
  ) {}

  // -------------------------------------------------------------------- GRNI

  async grni(
    companyId: string,
    query: GrniQuery,
    executor: DbExecutor = this.db,
  ): Promise<GrniReport> {
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const currency = await this.accounts.companyCurrency(companyId, executor);
    const settings = await this.config.settings(companyId, executor);
    const where: SQL[] = [
      eq(orders.companyId, companyId),
      eq(orders.orderType, 'PURCHASE_ORDER'),
      inArray(orders.status, ['APPROVED', 'CONFIRMED', 'CLOSED']),
      sql`${orderLines.receivedQuantity} > ${orderLines.billedQuantity}`,
    ];
    if (query.vendorId) where.push(eq(orders.vendorId, query.vendorId));
    const rows = await executor
      .select({
        line: orderLines,
        orderNumber: orders.documentNumber,
        vendorId: orders.vendorId,
        vendorCode: vendors.code,
        vendorName: vendors.name,
        currency: orders.currency,
        accountCode: accounts.code,
        lastReceiptDate: sql<string | null>`(
          select max(gr.receipt_date) from goods_receipt_lines grl
          join goods_receipts gr on gr.id = grl.goods_receipt_id
          where grl.order_line_id = ${orderLines.id} and gr.status = 'CONFIRMED' and gr.receipt_date <= ${asOf}
        )`,
      })
      .from(orderLines)
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .innerJoin(vendors, eq(vendors.id, orders.vendorId))
      .innerJoin(accounts, eq(accounts.id, orderLines.accountId))
      .where(and(...where))
      .orderBy(asc(vendors.name), asc(orders.documentNumber), asc(orderLines.lineNumber));

    const out: GrniRow[] = [];
    let stocked = Money.zero(currency);
    let unstocked = Money.zero(currency);
    let aged = Money.zero(currency);
    for (const r of rows) {
      if (r.currency !== currency) continue; // foreign POs are reported in their own analysis
      const v = grniValue(
        {
          orderLineId: r.line.id,
          receivedQuantity: r.line.receivedQuantity,
          billedQuantity: r.line.billedQuantity,
          unitPrice: r.line.unitPrice,
          lastReceiptDate: r.lastReceiptDate,
        },
        asOf,
        currency,
      );
      if (!v.amount.isPositive()) continue;
      const isStocked = r.line.productId !== null;
      const isAged = v.ageDays >= settings.grniAgeWarnDays;
      if (isStocked) stocked = stocked.add(v.amount);
      else unstocked = unstocked.add(v.amount);
      if (isAged) aged = aged.add(v.amount);
      out.push({
        orderId: r.line.orderId,
        orderNumber: r.orderNumber,
        orderLineId: r.line.id,
        lineNumber: r.line.lineNumber,
        description: r.line.description,
        vendorId: r.vendorId!,
        vendorCode: r.vendorCode,
        vendorName: r.vendorName,
        productId: r.line.productId,
        stocked: isStocked,
        accountId: r.line.accountId,
        accountCode: r.accountCode,
        receivedQuantity: r.line.receivedQuantity,
        billedQuantity: r.line.billedQuantity,
        openQuantity: v.quantity,
        unitPrice: r.line.unitPrice,
        amount: v.amount.toString(),
        currency,
        lastReceiptDate: r.lastReceiptDate,
        ageDays: v.ageDays,
        aged: isAged,
      });
    }
    const filtered = query.minAgeDays ? out.filter((r) => r.ageDays >= query.minAgeDays!) : out;
    const grniAccount = await this.accounts.resolveMapped(
      companyId,
      'GOODS_RECEIVED_NOT_INVOICED',
      executor,
    );
    const [bal] = await executor
      .select({
        balance: sql<string>`coalesce(sum(${journalLines.credit} - ${journalLines.debit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalLines.accountId, grniAccount.id),
          eq(journalEntries.status, 'POSTED'),
          lte(journalEntries.entryDate, asOf),
        ),
      );
    const grniBalance = Money.of(bal?.balance ?? '0', currency);
    return {
      asOf,
      currency,
      rows: filtered,
      totals: {
        stocked: stocked.toString(),
        unstocked: unstocked.toString(),
        total: stocked.add(unstocked).toString(),
        aged: aged.toString(),
        lines: filtered.length,
      },
      grniAccountBalance: grniBalance.toString(),
      difference: grniBalance.subtract(stocked).toString(),
    };
  }

  // ---------------------------------------------------------------- accruals

  async list(
    companyId: string,
    query: ListApAccrualsQuery,
  ): Promise<PaginatedResult<ApAccrual & { journalNumber: string | null }>> {
    const filters: SQL[] = [eq(apAccruals.companyId, companyId)];
    if (query.status) filters.push(eq(apAccruals.status, query.status));
    if (query.from) filters.push(gte(apAccruals.accrualDate, query.from));
    if (query.to) filters.push(lte(apAccruals.accrualDate, query.to));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.db
        .select({
          accrual: apAccruals,
          journalNumber: journalEntries.documentNumber,
        })
        .from(apAccruals)
        .leftJoin(journalEntries, eq(journalEntries.id, apAccruals.journalEntryId))
        .where(where)
        .orderBy(desc(apAccruals.accrualDate), desc(apAccruals.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, apAccruals, where),
    ]);
    return toPaginatedResult(
      rows.map((r) => ({ ...r.accrual, journalNumber: r.journalNumber })),
      total,
      query,
    );
  }

  async get(companyId: string, id: string): Promise<ApAccrualDetail> {
    const [row] = await this.db
      .select({ accrual: apAccruals, journalNumber: journalEntries.documentNumber })
      .from(apAccruals)
      .leftJoin(journalEntries, eq(journalEntries.id, apAccruals.journalEntryId))
      .where(and(eq(apAccruals.id, id), eq(apAccruals.companyId, companyId)));
    if (!row) throw new NotFoundError('AP accrual', id);
    const lines = await this.db
      .select({ line: apAccrualLines, accountCode: accounts.code, vendorName: vendors.name })
      .from(apAccrualLines)
      .innerJoin(accounts, eq(accounts.id, apAccrualLines.accountId))
      .leftJoin(vendors, eq(vendors.id, apAccrualLines.vendorId))
      .where(eq(apAccrualLines.accrualId, id))
      .orderBy(asc(apAccrualLines.lineNumber));
    return {
      ...row.accrual,
      journalNumber: row.journalNumber,
      lines: lines.map((l) => ({
        ...l.line,
        accountCode: l.accountCode,
        vendorName: l.vendorName,
      })),
    };
  }

  /** Draft an accrual: RECEIVED_NOT_BILLED computes the unstocked GRNI lines on the accrual date; MANUAL takes the lines given. */
  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateApAccrualInput,
  ): Promise<ApAccrualDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: apAccruals.id })
          .from(apAccruals)
          .where(
            and(
              eq(apAccruals.companyId, companyId),
              eq(apAccruals.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      if (input.reversalDate <= input.accrualDate)
        throw new BusinessRuleError(
          ErrorCodes.ACCRUAL_INVALID,
          'The reversal date must follow the accrual date.',
        );
      await this.posting.resolvePeriod(tx, companyId, input.accrualDate, { draft: true });
      const currency = await this.accounts.companyCurrency(companyId, tx);
      let lines: Array<{
        vendorId: string | null;
        orderId: string | null;
        orderLineId: string | null;
        description: string;
        accountId: string;
        amount: string;
        branchId: string | null;
        departmentId?: string | null;
        costCenterId?: string | null;
        projectId?: string | null;
      }>;
      if (input.source === 'MANUAL') {
        if (!input.lines?.length)
          throw new BusinessRuleError(
            ErrorCodes.ACCRUAL_INVALID,
            'A manual accrual needs at least one line.',
          );
        for (const l of input.lines) await this.accounts.getOrThrow(companyId, l.accountId, tx);
        await this.dimensions.validateRefs(
          tx,
          companyId,
          input.lines.map((l) => ({ ...l.dimensions })),
          input.accrualDate,
        );
        lines = input.lines.map((l) => ({
          vendorId: l.vendorId ?? null,
          orderId: l.orderId ?? null,
          orderLineId: l.orderLineId ?? null,
          description: l.description,
          accountId: l.accountId,
          amount: Money.parse(l.amount, currency).toString(),
          branchId: l.branchId ?? null,
          ...l.dimensions,
        }));
      } else {
        const grni = await this.grni(companyId, { asOf: input.accrualDate }, tx);
        lines = grni.rows
          .filter((r) => !r.stocked)
          .map((r) => ({
            vendorId: r.vendorId,
            orderId: r.orderId,
            orderLineId: r.orderLineId,
            description: `${r.orderNumber} L${r.lineNumber} ${r.description} (${r.openQuantity} received, not billed)`,
            accountId: r.accountId,
            amount: r.amount,
            branchId: null,
          }));
        if (!lines.length)
          throw new BusinessRuleError(
            ErrorCodes.ACCRUAL_INVALID,
            `Nothing to accrue: every receipt up to ${input.accrualDate} is billed or already in GRNI.`,
          );
      }
      const total = lines.reduce(
        (m, l) => m.add(Money.of(l.amount, currency)),
        Money.zero(currency),
      );
      const documentNumber = await this.numbering.allocate(
        companyId,
        'ACR',
        Number(input.accrualDate.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(apAccruals)
        .values({
          companyId,
          documentNumber,
          source: input.source,
          accrualDate: input.accrualDate,
          reversalDate: input.reversalDate,
          description: input.description ?? null,
          totalAmount: total.toString(),
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      await tx
        .insert(apAccrualLines)
        .values(lines.map((l, i) => ({ ...l, accrualId: created!.id, lineNumber: i + 1 })));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ApAccrual',
          entityId: created!.id,
          newValue: {
            documentNumber,
            source: input.source,
            accrualDate: input.accrualDate,
            total: total.toString(),
            lines: lines.length,
          },
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  /** Dr expense lines / Cr ACCRUED_EXPENSE on the accrual date, and the reversing entry on the reversal date. */
  async post(companyId: string, actor: AuthenticatedUser, id: string): Promise<ApAccrualDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      const lines = await tx
        .select()
        .from(apAccrualLines)
        .where(eq(apAccrualLines.accrualId, id))
        .orderBy(asc(apAccrualLines.lineNumber));
      const accrued = await this.accounts.resolveMapped(companyId, 'ACCRUED_EXPENSE', tx);
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const total = lines.reduce(
        (m, l) => m.add(Money.of(l.amount, currency)),
        Money.zero(currency),
      );
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: existing.accrualDate,
          description: `AP accrual ${existing.documentNumber}${existing.description ? ` - ${existing.description}` : ''}`,
          reference: existing.documentNumber,
          journalType: 'ACCRUAL',
          sourceType: 'AP_ACCRUAL',
          sourceId: existing.id,
          actor,
          lines: [
            ...lines.map((l) => ({
              accountId: l.accountId,
              debit: l.amount,
              credit: '0',
              description: l.description,
              branchId: l.branchId,
              departmentId: l.departmentId,
              costCenterId: l.costCenterId,
              projectId: l.projectId,
            })),
            {
              accountId: accrued.id,
              debit: '0',
              credit: total.toString(),
              description: `${existing.documentNumber} - accrued expenses (received not billed)`,
            },
          ],
        },
        { permission: P['ap-accrual.post'] },
      );
      const reversal = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: existing.reversalDate,
          description: `Reverse AP accrual ${existing.documentNumber}`,
          reference: existing.documentNumber,
          journalType: 'REVERSAL',
          sourceType: 'AP_ACCRUAL_REVERSAL',
          sourceId: existing.id,
          reversalOfId: entry.id,
          actor,
          lines: [
            ...lines.map((l) => ({
              accountId: l.accountId,
              debit: '0',
              credit: l.amount,
              description: l.description,
              branchId: l.branchId,
              departmentId: l.departmentId,
              costCenterId: l.costCenterId,
              projectId: l.projectId,
            })),
            {
              accountId: accrued.id,
              debit: total.toString(),
              credit: '0',
              description: `${existing.documentNumber} - accrual reversal`,
            },
          ],
        },
        { permission: P['ap-accrual.post'] },
      );
      await tx
        .update(journalEntries)
        .set({ status: 'REVERSED', reversedById: reversal.id })
        .where(eq(journalEntries.id, entry.id));
      await tx
        .update(apAccruals)
        .set({
          status: 'POSTED',
          journalEntryId: entry.id,
          reversalJournalEntryId: reversal.id,
          totalAmount: total.toString(),
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(apAccruals.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'ApAccrual',
          entityId: id,
          newValue: {
            status: 'POSTED',
            journalEntryId: entry.id,
            reversalJournalEntryId: reversal.id,
            total: total.toString(),
          },
          metadata: {
            documentNumber: existing.documentNumber,
            journalNumber: entry.documentNumber,
            reversalNumber: reversal.documentNumber,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'ap_accrual.posted',
        companyId,
        dedupeKey: 'ap_accrual.posted:' + id,
        payload: {
          accrualId: id,
          documentNumber: existing.documentNumber,
          accrualDate: existing.accrualDate,
          reversalDate: existing.reversalDate,
          total: total.toString(),
          currency,
          journalNumber: entry.documentNumber,
        },
      });
    });
    return this.get(companyId, id);
  }

  async remove(companyId: string, actor: AuthenticatedUser, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Only draft accruals can be deleted.',
        );
      await tx.delete(apAccruals).where(eq(apAccruals.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'ApAccrual',
          entityId: id,
          metadata: { documentNumber: existing.documentNumber, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<ApAccrual> {
    const [row] = await tx
      .select()
      .from(apAccruals)
      .where(and(eq(apAccruals.id, id), eq(apAccruals.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('AP accrual', id);
    return row;
  }
}
