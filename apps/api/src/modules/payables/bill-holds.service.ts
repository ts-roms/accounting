import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { PaginatedResult } from '@accounting/types';
import type {
  BillHoldInput,
  ListBillHoldsQuery,
  ReleaseBillHoldInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  billHolds,
  companies,
  users,
  vendorBills,
  vendors,
  type BillHold,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';

const MODULE = 'PAYABLES';

export interface BillHoldView extends BillHold {
  billNumber: string;
  vendorInvoiceNumber: string | null;
  vendorCode: string;
  vendorName: string;
  billTotal: string;
  billBalance: string;
  currency: string;
  placedByName: string | null;
  releasedByName: string | null;
}

/**
 * Payment holds (Prompt #7). A hold never changes the bill's accounting: the
 * liability stays posted; the bill is simply excluded from payment runs and
 * manual settlement until released. `vendor_bills.on_hold` mirrors the
 * existence of an ACTIVE hold so list filters and integrity checks stay cheap.
 */
@Injectable()
export class BillHoldsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(companyId: string, query: ListBillHoldsQuery): Promise<PaginatedResult<BillHoldView>> {
    const filters: SQL[] = [eq(billHolds.companyId, companyId)];
    if (query.status) filters.push(eq(billHolds.status, query.status));
    if (query.vendorId) filters.push(eq(billHolds.vendorId, query.vendorId));
    if (query.billId) filters.push(eq(billHolds.billId, query.billId));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(billHolds.placedAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, billHolds, where),
    ]);
    return toPaginatedResult(rows.map(decorate), total, query);
  }

  async get(companyId: string, id: string): Promise<BillHoldView> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(billHolds.id, id), eq(billHolds.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Bill hold', id);
    return decorate(row);
  }

  /** Place a hold on an open bill. One active hold per bill. */
  async hold(
    companyId: string,
    actor: AuthenticatedUser,
    billId: string,
    input: BillHoldInput,
  ): Promise<BillHoldView> {
    const id = await this.db.transaction(async (tx) => {
      const [bill] = await tx
        .select()
        .from(vendorBills)
        .where(and(eq(vendorBills.id, billId), eq(vendorBills.companyId, companyId)))
        .for('update');
      if (!bill) throw new NotFoundError('VendorBill', billId);
      if (bill.status === 'VOID' || bill.status === 'PAID')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${bill.documentNumber} is ${bill.status.toLowerCase()} and cannot be held.`,
        );
      if (bill.onHold)
        throw new BusinessRuleError(
          ErrorCodes.BILL_ON_HOLD,
          `${bill.documentNumber} already carries an active payment hold.`,
        );
      const [row] = await tx
        .insert(billHolds)
        .values({
          companyId,
          billId,
          vendorId: bill.vendorId,
          reason: input.reason,
          note: input.note ?? null,
          placedBy: actor.id,
        })
        .returning();
      await tx.update(vendorBills).set({ onHold: true }).where(eq(vendorBills.id, billId));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorBill',
          entityId: billId,
          previousValue: { onHold: false },
          newValue: { onHold: true, holdReason: input.reason },
          metadata: {
            documentNumber: bill.documentNumber,
            editor: actor.email,
            reason: input.note ?? input.reason,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'bill.on_hold',
        companyId,
        dedupeKey: `bill.on_hold:${row!.id}`,
        payload: {
          billId,
          documentNumber: bill.documentNumber,
          vendorId: bill.vendorId,
          reason: input.reason,
          note: input.note ?? null,
          total: bill.total,
          currency: bill.currency,
        },
      });
      const [company] = await tx
        .select({ organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, companyId));
      await this.notifications.notify(
        {
          organizationId: company!.organizationId,
          eventType: 'BILL_ON_HOLD',
          severity: 'WARNING',
          title: `${bill.documentNumber} placed on payment hold`,
          body: `${input.reason.toLowerCase().replace(/_/g, ' ')}${input.note ? ` - ${input.note}` : ''}`,
          link: `/purchasing/bills/${billId}`,
          entityType: 'VendorBill',
          entityId: billId,
          permission: 'bill.hold',
          companyId,
          dedupeKey: `bill-hold:${row!.id}`,
        },
        tx,
      );
      return row!.id;
    });
    return this.get(companyId, id);
  }

  async release(
    companyId: string,
    actor: AuthenticatedUser,
    holdId: string,
    input: ReleaseBillHoldInput,
  ): Promise<BillHoldView> {
    await this.db.transaction(async (tx) => {
      const [hold] = await tx
        .select()
        .from(billHolds)
        .where(and(eq(billHolds.id, holdId), eq(billHolds.companyId, companyId)))
        .for('update');
      if (!hold) throw new NotFoundError('Bill hold', holdId);
      if (hold.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'This hold was already released.',
        );
      await tx
        .update(billHolds)
        .set({
          status: 'RELEASED',
          releasedBy: actor.id,
          releasedAt: new Date(),
          releaseNote: input.note ?? null,
        })
        .where(eq(billHolds.id, holdId));
      await this.syncFlag(tx, hold.billId);
      const [bill] = await tx
        .select({ documentNumber: vendorBills.documentNumber, vendorId: vendorBills.vendorId })
        .from(vendorBills)
        .where(eq(vendorBills.id, hold.billId));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorBill',
          entityId: hold.billId,
          previousValue: { onHold: true, holdReason: hold.reason },
          newValue: { onHold: false },
          metadata: {
            documentNumber: bill?.documentNumber,
            editor: actor.email,
            reason: input.note ?? null,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'bill.released',
        companyId,
        dedupeKey: `bill.released:${holdId}`,
        payload: {
          billId: hold.billId,
          documentNumber: bill?.documentNumber,
          vendorId: hold.vendorId,
          reason: hold.reason,
          releaseNote: input.note ?? null,
        },
      });
    });
    return this.get(companyId, holdId);
  }

  /** Recompute `vendor_bills.on_hold` from the active holds. */
  async syncFlag(tx: DbExecutor, billId: string): Promise<void> {
    const [active] = await tx
      .select({ id: billHolds.id })
      .from(billHolds)
      .where(and(eq(billHolds.billId, billId), eq(billHolds.status, 'ACTIVE')))
      .limit(1);
    await tx
      .update(vendorBills)
      .set({ onHold: Boolean(active) })
      .where(eq(vendorBills.id, billId));
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        hold: billHolds,
        billNumber: vendorBills.documentNumber,
        vendorInvoiceNumber: vendorBills.vendorInvoiceNumber,
        vendorCode: vendors.code,
        vendorName: vendors.name,
        billTotal: vendorBills.total,
        billAllocated: vendorBills.allocatedAmount,
        currency: vendorBills.currency,
        placedByName: users.email,
      })
      .from(billHolds)
      .innerJoin(vendorBills, eq(vendorBills.id, billHolds.billId))
      .innerJoin(vendors, eq(vendors.id, billHolds.vendorId))
      .leftJoin(users, eq(users.id, billHolds.placedBy));
  }
}

function decorate(row: {
  hold: BillHold;
  billNumber: string;
  vendorInvoiceNumber: string | null;
  vendorCode: string;
  vendorName: string;
  billTotal: string;
  billAllocated: string;
  currency: string;
  placedByName: string | null;
}): BillHoldView {
  return {
    ...row.hold,
    billNumber: row.billNumber,
    vendorInvoiceNumber: row.vendorInvoiceNumber,
    vendorCode: row.vendorCode,
    vendorName: row.vendorName,
    billTotal: row.billTotal,
    billBalance: Money.of(row.billTotal, row.currency)
      .subtract(Money.of(row.billAllocated, row.currency))
      .toString(),
    currency: row.currency,
    placedByName: row.placedByName,
    releasedByName: null,
  };
}
