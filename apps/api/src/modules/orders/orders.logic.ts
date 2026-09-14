import { Money } from '@accounting/money';
import type { FulfillmentStatus, MatchException, OrderStatus, OrderType } from '@accounting/types';
import type { OrderLineInput } from '@accounting/validation';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { lineAmounts } from '@/modules/subledger/subledger.logic';

/** Pure rules shared by quotations, sales orders, purchase requests, purchase orders, receipts and matching. */

export interface ComputedOrderLine {
  lineNumber: number;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  amount: string;
  accountId: string;
  branchId: string | null;
  productId: string | null;
  warehouseId: string | null;
}

/** Lines with exact-decimal net amounts; the order total is subtotal (gross) less discounts. */
export function computeOrderLines(
  lines: OrderLineInput[],
  currency: string,
): { lines: ComputedOrderLine[]; subtotal: Money; discountTotal: Money; total: Money } {
  let subtotal = Money.zero(currency);
  let discountTotal = Money.zero(currency);
  const computed = lines.map((line, index) => {
    const { gross, discount, net } = lineAmounts(
      line.quantity,
      line.unitPrice,
      line.discountPercent,
      currency,
    );
    subtotal = subtotal.add(gross);
    discountTotal = discountTotal.add(discount);
    return {
      lineNumber: index + 1,
      description: line.description,
      quantity: Money.of(line.quantity, currency).toString(),
      unitPrice: Money.parse(line.unitPrice, currency).toString(),
      discountPercent: Money.of(line.discountPercent, currency).toString(),
      amount: net.toString(),
      accountId: line.accountId,
      branchId: line.branchId ?? null,
      productId: line.productId ?? null,
      warehouseId: line.warehouseId ?? null,
    };
  });
  const total = subtotal.subtract(discountTotal);
  if (total.isZero()) {
    throw new BusinessRuleError(
      ErrorCodes.VALIDATION_FAILED,
      'The order total must be greater than zero.',
    );
  }
  return { lines: computed, subtotal, discountTotal, total };
}

/** Net unit price after discount, used when crediting a return. */
export function netUnitPrice(unitPrice: string, discountPercent: string, currency: string): Money {
  return lineAmounts('1', unitPrice, discountPercent, currency).net;
}

// ---------------------------------------------------------------- lifecycle

export interface OrderTypeRules {
  /** Party the order belongs to. */
  party: 'CUSTOMER' | 'VENDOR' | 'VENDOR_OPTIONAL';
  /** Status reached by the "approve" step (quotations are accepted, requests approved, ...). */
  transitions: Partial<Record<OrderAction, { from: OrderStatus[]; to: OrderStatus }>>;
  /** What fulfilment counters mean for this type. */
  tracksReceipts: boolean;
  tracksBilling: boolean;
  /** Type produced by "convert". */
  convertsTo?: OrderType;
}

export type OrderAction =
  'submit' | 'send' | 'accept' | 'approve' | 'reject' | 'convert' | 'close' | 'cancel';

export const ORDER_RULES: Record<OrderType, OrderTypeRules> = {
  QUOTATION: {
    party: 'CUSTOMER',
    transitions: {
      send: { from: ['DRAFT'], to: 'SENT' },
      accept: { from: ['DRAFT', 'SENT'], to: 'ACCEPTED' },
      reject: { from: ['SENT', 'ACCEPTED'], to: 'REJECTED' },
      convert: { from: ['ACCEPTED'], to: 'CONVERTED' },
      cancel: { from: ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'], to: 'CANCELLED' },
    },
    tracksReceipts: false,
    tracksBilling: false,
    convertsTo: 'SALES_ORDER',
  },
  SALES_ORDER: {
    party: 'CUSTOMER',
    transitions: {
      approve: { from: ['DRAFT'], to: 'APPROVED' },
      close: { from: ['APPROVED'], to: 'CLOSED' },
      cancel: { from: ['DRAFT', 'APPROVED'], to: 'CANCELLED' },
    },
    tracksReceipts: false,
    tracksBilling: true,
  },
  PURCHASE_REQUEST: {
    party: 'VENDOR_OPTIONAL',
    transitions: {
      submit: { from: ['DRAFT', 'REJECTED'], to: 'SUBMITTED' },
      approve: { from: ['SUBMITTED'], to: 'APPROVED' },
      reject: { from: ['SUBMITTED'], to: 'REJECTED' },
      convert: { from: ['APPROVED'], to: 'CONVERTED' },
      cancel: { from: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'], to: 'CANCELLED' },
    },
    tracksReceipts: false,
    tracksBilling: false,
    convertsTo: 'PURCHASE_ORDER',
  },
  PURCHASE_ORDER: {
    party: 'VENDOR',
    transitions: {
      approve: { from: ['DRAFT'], to: 'APPROVED' },
      close: { from: ['APPROVED'], to: 'CLOSED' },
      cancel: { from: ['DRAFT', 'APPROVED'], to: 'CANCELLED' },
    },
    tracksReceipts: true,
    tracksBilling: true,
  },
};

/** Statuses in which the header and lines may still be edited. */
export const EDITABLE_STATUSES: readonly OrderStatus[] = ['DRAFT', 'REJECTED'];

export function nextStatus(
  type: OrderType,
  action: OrderAction,
  current: OrderStatus,
): OrderStatus {
  const transition = ORDER_RULES[type].transitions[action];
  if (!transition || !transition.from.includes(current)) {
    throw new BusinessRuleError(
      ErrorCodes.ORDER_INVALID_STATE,
      `A ${labelForType(type).toLowerCase()} in status ${current} cannot be ${pastTense(action)}.`,
      { status: current, action },
    );
  }
  return transition.to;
}

export function labelForType(type: OrderType): string {
  return {
    QUOTATION: 'Quotation',
    SALES_ORDER: 'Sales order',
    PURCHASE_REQUEST: 'Purchase request',
    PURCHASE_ORDER: 'Purchase order',
  }[type];
}

function pastTense(action: OrderAction): string {
  return {
    submit: 'submitted',
    send: 'sent',
    accept: 'accepted',
    approve: 'approved',
    reject: 'rejected',
    convert: 'converted',
    close: 'closed',
    cancel: 'cancelled',
  }[action];
}

// --------------------------------------------------------------- fulfilment

/** Fulfilment status of an order from its lines' ordered vs. fulfilled quantities. */
export function deriveFulfillment(
  lines: Array<{ quantity: string; fulfilled: string }>,
  currency: string,
): FulfillmentStatus {
  let any = false;
  let all = true;
  for (const line of lines) {
    const ordered = Money.of(line.quantity, currency);
    const done = Money.of(line.fulfilled, currency);
    if (done.isPositive()) any = true;
    if (done.lessThan(ordered)) all = false;
  }
  if (!any) return 'NONE';
  return all ? 'FULL' : 'PARTIAL';
}

/**
 * Quantity still available on a line for a given activity; `tolerancePercent`
 * allows over-fulfilment (e.g. receiving 2% more than ordered).
 */
export function assertWithinRemaining(
  line: { lineNumber: number; quantity: string; fulfilled: string },
  requested: string,
  currency: string,
  activity: string,
  tolerancePercent = '0',
): void {
  const ordered = Money.of(line.quantity, currency);
  const cap = ordered.add(ordered.multiply(tolerancePercent).multiply('0.01'));
  const after = Money.of(line.fulfilled, currency).add(Money.of(requested, currency));
  if (after.greaterThan(cap)) {
    const remaining = cap.subtract(Money.of(line.fulfilled, currency));
    throw new BusinessRuleError(
      ErrorCodes.ORDER_LINE_OVERFULFILLED,
      `Line ${line.lineNumber}: ${activity} ${requested} exceeds the remaining quantity ${remaining.toString()}.`,
      { lineNumber: String(line.lineNumber), remaining: remaining.toString() },
    );
  }
}

// ----------------------------------------------------------- three-way match

export interface MatchLineInput {
  lineNumber: number;
  orderLineId: string | null;
  quantity: string;
  unitPrice: string;
}

export interface MatchOrderLine {
  id: string;
  lineNumber: number;
  quantity: string;
  unitPrice: string;
  receivedQuantity: string;
  /** Quantity billed by OTHER bills (the bill being matched is excluded). */
  billedElsewhere: string;
}

export interface MatchSettings {
  priceTolerancePercent: string;
  quantityTolerancePercent: string;
  requirePurchaseOrder: boolean;
  requireReceiptBeforeBill: boolean;
}

/**
 * Compares a vendor bill with its purchase order and the confirmed goods
 * receipts. Pure: the caller loads the data and stores the result.
 */
export function evaluateMatch(
  bill: { purchaseOrderId: string | null; lines: MatchLineInput[]; duplicateSuspected: boolean },
  orderLines: Map<string, MatchOrderLine>,
  settings: MatchSettings,
  currency: string,
): { status: 'NOT_REQUIRED' | 'MATCHED' | 'EXCEPTION'; exceptions: MatchException[] } {
  const exceptions: MatchException[] = [];
  if (bill.duplicateSuspected) {
    exceptions.push({
      code: 'DUPLICATE_INVOICE',
      message: 'A bill for the same vendor and amount was recorded within the last 7 days.',
      details: {},
    });
  }
  if (!bill.purchaseOrderId) {
    if (settings.requirePurchaseOrder) {
      exceptions.push({
        code: 'MISSING_PURCHASE_ORDER',
        message: 'This bill is not linked to a purchase order.',
        details: {},
      });
    }
    return exceptions.length
      ? { status: 'EXCEPTION', exceptions }
      : { status: 'NOT_REQUIRED', exceptions };
  }

  // Tolerances as decimal factors (e.g. "2.5" -> 0.025), applied with exact-decimal arithmetic.
  const qtyTolerance = (base: Money) =>
    base.multiply(settings.quantityTolerancePercent).multiply('0.01');
  const priceTolerance = (base: Money) =>
    base.multiply(settings.priceTolerancePercent).multiply('0.01');

  for (const line of bill.lines) {
    if (!line.orderLineId) {
      exceptions.push({
        code: 'MISSING_PURCHASE_ORDER',
        message: `Line ${line.lineNumber} is not linked to a purchase order line.`,
        lineNumber: line.lineNumber,
        details: {},
      });
      continue;
    }
    const po = orderLines.get(line.orderLineId);
    if (!po) continue; // validated earlier by the fulfilment service
    const billed = Money.of(line.quantity, currency);
    const ordered = Money.of(po.quantity, currency);
    const received = Money.of(po.receivedQuantity, currency);
    const availableToBill = received.subtract(Money.of(po.billedElsewhere, currency));

    // Quantity: billed must not exceed ordered (plus tolerance) ...
    const orderedCap = ordered.add(qtyTolerance(ordered));
    if (billed.greaterThan(orderedCap)) {
      exceptions.push({
        code: 'QUANTITY_MISMATCH',
        message: `Line ${line.lineNumber}: billed ${billed.toString()} exceeds ordered ${ordered.toString()}.`,
        lineNumber: line.lineNumber,
        details: { ordered: ordered.toString(), billed: billed.toString() },
      });
    }
    // ... and must be covered by confirmed receipts when the company requires it.
    if (settings.requireReceiptBeforeBill) {
      if (!received.isPositive()) {
        exceptions.push({
          code: 'MISSING_RECEIPT',
          message: `Line ${line.lineNumber}: nothing has been received for PO line ${po.lineNumber}.`,
          lineNumber: line.lineNumber,
          details: { ordered: ordered.toString(), received: '0.0000' },
        });
      } else {
        const receivedCap = availableToBill.add(qtyTolerance(availableToBill));
        if (billed.greaterThan(receivedCap)) {
          exceptions.push({
            code: 'QUANTITY_MISMATCH',
            message: `Line ${line.lineNumber}: billed ${billed.toString()} but only ${availableToBill.toString()} received and unbilled.`,
            lineNumber: line.lineNumber,
            details: {
              received: received.toString(),
              availableToBill: availableToBill.toString(),
              billed: billed.toString(),
            },
          });
        }
      }
    }
    // Price: unit price within tolerance of the order price.
    const orderPrice = Money.of(po.unitPrice, currency);
    const billPrice = Money.of(line.unitPrice, currency);
    const variance = billPrice.subtract(orderPrice);
    const allowed = priceTolerance(orderPrice);
    if (variance.abs().greaterThan(allowed)) {
      exceptions.push({
        code: 'PRICE_MISMATCH',
        message: `Line ${line.lineNumber}: billed at ${billPrice.toString()} vs. ordered ${orderPrice.toString()}.`,
        lineNumber: line.lineNumber,
        details: {
          orderPrice: orderPrice.toString(),
          billPrice: billPrice.toString(),
          variance: variance.toString(),
        },
      });
    }
  }
  return exceptions.length
    ? { status: 'EXCEPTION', exceptions }
    : { status: 'MATCHED', exceptions };
}
