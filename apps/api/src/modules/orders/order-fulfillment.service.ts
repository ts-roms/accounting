import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { OPEN_ORDER_STATUSES, type OrderStatus, type OrderType } from '@accounting/types';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import type { DbExecutor } from '@/database/database.types';
import { orderLines, orders, type Order, type OrderLine } from '@/database/schema';
import { assertWithinRemaining, deriveFulfillment, labelForType } from './orders.logic';

export type FulfillmentKind = 'RECEIPT' | 'BILLING' | 'RETURN' | 'DELIVERY';

const COUNTER: Record<
  FulfillmentKind,
  'receivedQuantity' | 'billedQuantity' | 'returnedQuantity' | 'deliveredQuantity'
> = {
  RECEIPT: 'receivedQuantity',
  BILLING: 'billedQuantity',
  RETURN: 'returnedQuantity',
  DELIVERY: 'deliveredQuantity',
};

export interface FulfillmentLine {
  orderLineId: string;
  quantity: string;
}

/**
 * Maintains the fulfilment counters on order lines (received, billed / invoiced,
 * returned) inside the caller's transaction, and derives the order's receipt
 * and billing status. Used by goods receipts, invoices, bills and returns so
 * an order line can never be over-fulfilled.
 */
@Injectable()
export class OrderFulfillmentService {
  /** Locks the order and its lines; verifies it is open for fulfilment. */
  async lockOpenOrder(
    tx: DbExecutor,
    companyId: string,
    orderId: string,
    expectedType: OrderType,
    partyId?: string,
    allowedStatuses: readonly OrderStatus[] = OPEN_ORDER_STATUSES,
  ): Promise<{ order: Order; lines: OrderLine[] }> {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.companyId, companyId)))
      .for('update');
    if (!order) throw new NotFoundError(labelForType(expectedType), orderId);
    if (order.orderType !== expectedType) {
      throw new BusinessRuleError(
        ErrorCodes.ORDER_INVALID_STATE,
        `${order.documentNumber} is a ${labelForType(order.orderType).toLowerCase()}, not a ${labelForType(expectedType).toLowerCase()}.`,
      );
    }
    if (!allowedStatuses.includes(order.status)) {
      throw new BusinessRuleError(
        ErrorCodes.ORDER_INVALID_STATE,
        `${order.documentNumber} is ${order.status}; only ${allowedStatuses.join(' / ').toLowerCase()} orders can be fulfilled.`,
        { status: order.status },
      );
    }
    const orderParty = order.customerId ?? order.vendorId;
    if (partyId && orderParty !== partyId) {
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `${order.documentNumber} belongs to a different ${order.customerId ? 'customer' : 'vendor'}.`,
      );
    }
    const lines = await tx
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, orderId))
      .orderBy(asc(orderLines.lineNumber))
      .for('update');
    return { order, lines };
  }

  /**
   * Adds the fulfilled quantities to the order lines and refreshes the order
   * status. Rejects unknown lines and over-fulfilment (beyond the tolerance).
   * For returns, the cap is what was actually invoiced / received.
   */
  async consume(
    tx: DbExecutor,
    companyId: string,
    orderId: string,
    kind: FulfillmentKind,
    lines: FulfillmentLine[],
    options: { expectedType: OrderType; partyId?: string; tolerancePercent?: string },
  ): Promise<{ order: Order; lines: OrderLine[] }> {
    const { order, lines: orderRows } = await this.lockOpenOrder(
      tx,
      companyId,
      orderId,
      options.expectedType,
      options.partyId,
      kind === 'RETURN' ? [...OPEN_ORDER_STATUSES, 'CLOSED'] : OPEN_ORDER_STATUSES,
    );
    const byId = new Map(orderRows.map((l) => [l.id, l]));
    const seen = new Set<string>();
    for (const line of lines) {
      if (seen.has(line.orderLineId)) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'An order line can only appear once per document.',
        );
      }
      seen.add(line.orderLineId);
      const target = byId.get(line.orderLineId);
      if (!target) {
        throw new NotFoundError('Order line', line.orderLineId);
      }
      const counter = COUNTER[kind];
      // Returns are capped by what actually left / arrived, not by the order quantity.
      const cap =
        kind === 'RETURN'
          ? options.expectedType === 'SALES_ORDER'
            ? target.billedQuantity
            : target.receivedQuantity
          : target.quantity;
      assertWithinRemaining(
        { lineNumber: target.lineNumber, quantity: cap, fulfilled: target[counter] },
        line.quantity,
        order.currency,
        kind === 'RECEIPT'
          ? 'receiving'
          : kind === 'BILLING'
            ? 'billing'
            : kind === 'DELIVERY'
              ? 'delivering'
              : 'returning',
        kind === 'RECEIPT' ? (options.tolerancePercent ?? '0') : '0',
      );
      await tx
        .update(orderLines)
        .set({ [counter]: sql`${orderLines[counter]} + ${line.quantity}` })
        .where(eq(orderLines.id, line.orderLineId));
    }
    await this.refreshStatus(tx, orderId);
    return { order, lines: orderRows };
  }

  /** Subtracts fulfilled quantities (a draft document deleted, a bill voided, a receipt cancelled). */
  async release(
    tx: DbExecutor,
    orderId: string,
    kind: FulfillmentKind,
    lines: FulfillmentLine[],
  ): Promise<void> {
    const counter = COUNTER[kind];
    for (const line of lines) {
      await tx
        .update(orderLines)
        .set({ [counter]: sql`GREATEST(${orderLines[counter]} - ${line.quantity}, 0)` })
        .where(eq(orderLines.id, line.orderLineId));
    }
    await this.refreshStatus(tx, orderId);
  }

  /** Recomputes receipt / billing status; auto-closes an approved order once fully fulfilled. */
  async refreshStatus(tx: DbExecutor, orderId: string): Promise<void> {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return;
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const currency = order.currency;
    const receiptStatus = deriveFulfillment(
      lines.map((l) => ({ quantity: l.quantity, fulfilled: l.receivedQuantity })),
      currency,
    );
    const billingStatus = deriveFulfillment(
      lines.map((l) => ({ quantity: l.quantity, fulfilled: l.billedQuantity })),
      currency,
    );
    const deliveryStatus = deriveFulfillment(
      lines.map((l) => ({ quantity: l.quantity, fulfilled: l.deliveredQuantity })),
      currency,
    );
    const fullyDone =
      order.orderType === 'PURCHASE_ORDER'
        ? receiptStatus === 'FULL' && billingStatus === 'FULL'
        : billingStatus === 'FULL';
    const status =
      OPEN_ORDER_STATUSES.includes(order.status) && fullyDone
        ? 'CLOSED'
        : order.status === 'CLOSED' && !fullyDone && order.closedAt === null
          ? 'APPROVED' // auto-closed order re-opened by a void / cancellation
          : order.status;
    await tx
      .update(orders)
      .set({
        receiptStatus,
        billingStatus,
        deliveryStatus,
        status,
      })
      .where(eq(orders.id, orderId));
  }

  /** Order lines by id (no locking) for read-side decoration. */
  async linesById(tx: DbExecutor, ids: string[]): Promise<Map<string, OrderLine>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.select().from(orderLines).where(inArray(orderLines.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Remaining quantity helper for views. */
  remaining(
    line: OrderLine,
    kind: FulfillmentKind,
    currency: string,
    orderType: OrderType,
  ): string {
    const cap =
      kind === 'RETURN'
        ? orderType === 'SALES_ORDER'
          ? line.billedQuantity
          : line.receivedQuantity
        : line.quantity;
    const done = line[COUNTER[kind]];
    const left = Money.of(cap, currency).subtract(Money.of(done, currency));
    return left.isNegative() ? '0.0000' : left.toString();
  }
}
