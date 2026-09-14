import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { MatchException, MatchStatus } from '@accounting/types';
import type { PurchasingSettingsInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { AuditService } from '@/modules/audit/audit.service';
import {
  billLines,
  orderLines,
  purchasingSettings,
  vendorBills,
  type PurchasingSettings,
} from '@/database/schema';
import { evaluateMatch, type MatchOrderLine } from './orders.logic';

const MODULE = 'PURCHASING';
// Drizzle renders single-table selects with unqualified column names, which a
// correlated subquery would resolve against its own tables - qualify explicitly.
const OUTER_LINE = sql.raw('"order_lines"."id"');

export const DEFAULT_SETTINGS: PurchasingSettingsInput = {
  priceTolerancePercent: '0',
  quantityTolerancePercent: '0',
  overReceiptTolerancePercent: '0',
  requirePurchaseOrder: false,
  requireReceiptBeforeBill: true,
};

/**
 * Three-way matching (purchase order + goods receipts + vendor bill) and the
 * per-company purchasing settings that parameterise it. Match results live on
 * the bill (`match_status`, `match_exceptions`); unreviewed exceptions put the
 * bill on payment hold.
 */
@Injectable()
export class MatchingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- settings

  async settings(companyId: string, executor: DbExecutor = this.db): Promise<PurchasingSettings> {
    const [row] = await executor
      .select()
      .from(purchasingSettings)
      .where(eq(purchasingSettings.companyId, companyId));
    return (
      row ?? {
        companyId,
        ...DEFAULT_SETTINGS,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
    );
  }

  async updateSettings(
    companyId: string,
    actor: AuthenticatedUser,
    input: PurchasingSettingsInput,
  ): Promise<PurchasingSettings> {
    return this.db.transaction(async (tx) => {
      const previous = await this.settings(companyId, tx);
      const [row] = await tx
        .insert(purchasingSettings)
        .values({ companyId, ...input })
        .onConflictDoUpdate({ target: purchasingSettings.companyId, set: { ...input } })
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PurchasingSettings',
          entityId: companyId,
          previousValue: { ...previous, createdAt: undefined, updatedAt: undefined },
          newValue: input,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  // ---------------------------------------------------------------- matching

  /**
   * Evaluates and stores the match for one bill. `duplicateSuspected` comes
   * from the bill's duplicate detection so the exception list is complete.
   */
  async evaluateBill(
    tx: DbExecutor,
    companyId: string,
    billId: string,
    duplicateSuspected = false,
  ): Promise<{ status: MatchStatus; exceptions: MatchException[] }> {
    const [bill] = await tx
      .select()
      .from(vendorBills)
      .where(and(eq(vendorBills.id, billId), eq(vendorBills.companyId, companyId)));
    if (!bill) throw new Error(`Bill ${billId} not found for matching`);
    // Credit / debit notes and voided bills are never matched.
    if (bill.documentType !== 'INVOICE' || bill.status === 'VOID') {
      return { status: bill.matchStatus, exceptions: bill.matchExceptions };
    }
    const settings = await this.settings(companyId, tx);
    const lines = await tx.select().from(billLines).where(eq(billLines.billId, billId));
    const poLineIds = lines.map((l) => l.orderLineId).filter((id): id is string => Boolean(id));
    const poLines = new Map<string, MatchOrderLine>();
    if (poLineIds.length > 0) {
      const rows = await tx
        .select({
          id: orderLines.id,
          lineNumber: orderLines.lineNumber,
          quantity: orderLines.quantity,
          unitPrice: orderLines.unitPrice,
          receivedQuantity: orderLines.receivedQuantity,
          billedElsewhere: sql<string>`coalesce((
            select sum(bl.quantity) from bill_lines bl
            join vendor_bills vb on vb.id = bl.bill_id
            where bl.order_line_id = ${OUTER_LINE} and vb.id <> ${billId} and vb.status <> 'VOID'
          ), 0)`,
        })
        .from(orderLines)
        .where(inArray(orderLines.id, poLineIds));
      for (const r of rows) poLines.set(r.id, r);
    }
    const result = evaluateMatch(
      {
        purchaseOrderId: bill.purchaseOrderId,
        duplicateSuspected,
        lines: lines.map((l) => ({
          lineNumber: l.lineNumber,
          orderLineId: l.orderLineId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
      },
      poLines,
      settings,
      bill.currency,
    );
    // A reviewed bill stays reviewed while its exception set is unchanged.
    const status: MatchStatus =
      result.status === 'EXCEPTION' &&
      bill.matchStatus === 'REVIEWED' &&
      sameExceptions(bill.matchExceptions, result.exceptions)
        ? 'REVIEWED'
        : result.status;
    await tx
      .update(vendorBills)
      .set({
        matchStatus: status,
        matchExceptions: result.exceptions,
        ...(status !== 'REVIEWED'
          ? { matchReviewedAt: null, matchReviewedBy: null, matchReviewNote: null }
          : {}),
      })
      .where(eq(vendorBills.id, billId));
    return { status, exceptions: result.exceptions };
  }

  /** Re-runs matching for every open bill of a purchase order (after a receipt is confirmed or cancelled). */
  async reevaluateOrder(tx: DbExecutor, companyId: string, purchaseOrderId: string): Promise<void> {
    const bills = await tx
      .select({ id: vendorBills.id })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.purchaseOrderId, purchaseOrderId),
          ne(vendorBills.status, 'VOID'),
        ),
      );
    for (const b of bills) await this.evaluateBill(tx, companyId, b.id);
  }

  /** An approver acknowledges the exceptions; the bill leaves payment hold. */
  async review(
    companyId: string,
    actor: AuthenticatedUser,
    billId: string,
    note: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [bill] = await tx
        .select()
        .from(vendorBills)
        .where(and(eq(vendorBills.id, billId), eq(vendorBills.companyId, companyId)))
        .for('update');
      if (!bill) throw new BusinessRuleError(ErrorCodes.NOT_FOUND, 'Bill not found.');
      if (bill.matchStatus !== 'EXCEPTION') {
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${bill.documentNumber} has no unreviewed matching exceptions.`,
          { matchStatus: bill.matchStatus },
        );
      }
      await tx
        .update(vendorBills)
        .set({
          matchStatus: 'REVIEWED',
          matchReviewedBy: actor.id,
          matchReviewedAt: new Date(),
          matchReviewNote: note,
        })
        .where(eq(vendorBills.id, billId));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'VendorBillMatch',
          entityId: billId,
          previousValue: { matchStatus: 'EXCEPTION', exceptions: bill.matchExceptions },
          newValue: { matchStatus: 'REVIEWED', note },
          metadata: { documentNumber: bill.documentNumber },
          companyId,
        },
        tx,
      );
    });
  }
}

function sameExceptions(a: MatchException[], b: MatchException[]): boolean {
  const key = (e: MatchException) => `${e.code}:${e.lineNumber ?? ''}:${JSON.stringify(e.details)}`;
  const as = a.map(key).sort();
  const bs = b.map(key).sort();
  return as.length === bs.length && as.every((k, i) => k === bs[i]);
}
