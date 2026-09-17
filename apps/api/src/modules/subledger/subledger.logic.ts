import { Money } from '@accounting/money';
import {
  AGING_BUCKETS,
  type AgingBucketKey,
  type SubledgerDocumentStatus,
  type SubledgerDocumentType,
} from '@accounting/types';
import type { RevenueMilestone } from '@accounting/types';
import type { DocumentLineInput } from '@accounting/validation';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';

/** Pure calculations shared by the AR and AP subledgers. */

export interface ComputedLine {
  lineNumber: number;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  amount: string;
  accountId: string;
  branchId: string | null;
  orderLineId: string | null;
  productId: string | null;
  warehouseId: string | null;
  lotNumber: string | null;
  serialNumbers: string[];
  departmentId: string | null;
  costCenterId: string | null;
  projectId: string | null;
  taxCodeId: string | null;
  withholdingTaxCodeId: string | null;
  /** Revenue recognition (Prompt #10) - stored on invoice lines only. */
  revenuePolicyId: string | null;
  serviceStartDate: string | null;
  serviceEndDate: string | null;
  milestones: RevenueMilestone[];
}

/** Gross = quantity x unit price; net = gross x (1 - discount%), each rounded half-even to 4 places. */
export function lineAmounts(
  quantity: string,
  unitPrice: string,
  discountPercent: string,
  currency: string,
): { gross: Money; net: Money; discount: Money } {
  const gross = Money.parse(unitPrice, currency).multiply(quantity);
  const discount = gross.multiply(discountPercent).multiply('0.01');
  return { gross, discount, net: gross.subtract(discount) };
}

/** Line amount = quantity x unit price less discount; subtotal is the exact sum of net amounts. */
export function computeLines(
  lines: Array<Omit<DocumentLineInput, 'discountPercent'> & { discountPercent?: string }>,
  currency: string,
): { lines: ComputedLine[]; subtotal: Money } {
  let subtotal = Money.zero(currency);
  const computed = lines.map((line, index) => {
    const discountPercent = line.discountPercent ?? '0';
    const { net } = lineAmounts(line.quantity, line.unitPrice, discountPercent, currency);
    subtotal = subtotal.add(net);
    return {
      lineNumber: index + 1,
      description: line.description,
      quantity: Money.of(line.quantity, currency).toString(),
      unitPrice: Money.parse(line.unitPrice, currency).toString(),
      discountPercent: Money.of(discountPercent, currency).toString(),
      amount: net.toString(),
      accountId: line.accountId,
      branchId: line.branchId ?? null,
      orderLineId: line.orderLineId ?? null,
      productId: line.productId ?? null,
      warehouseId: line.warehouseId ?? null,
      lotNumber: line.lotNumber ?? null,
      serialNumbers: line.serialNumbers ?? [],
      departmentId: line.departmentId ?? null,
      costCenterId: line.costCenterId ?? null,
      projectId: line.projectId ?? null,
      taxCodeId: line.taxCodeId ?? null,
      withholdingTaxCodeId: line.withholdingTaxCodeId ?? null,
      revenuePolicyId: line.revenuePolicyId ?? null,
      serviceStartDate: line.serviceStartDate ?? null,
      serviceEndDate: line.serviceEndDate ?? null,
      milestones: line.milestones ?? [],
    };
  });
  if (subtotal.isZero()) {
    throw new BusinessRuleError(
      ErrorCodes.VALIDATION_FAILED,
      'The document total must be greater than zero.',
    );
  }
  return { lines: computed, subtotal };
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = toIso.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Business status of an open document from its settled amount. */
export function deriveDocumentStatus(total: Money, allocated: Money): SubledgerDocumentStatus {
  if (allocated.isZero()) return 'APPROVED';
  if (allocated.lessThan(total)) return 'PARTIALLY_PAID';
  return 'PAID';
}

/** Documents that increase the party balance (invoices/bills and debit notes) vs credits. */
export function isDebitDocument(type: SubledgerDocumentType): boolean {
  return type === 'INVOICE' || type === 'DEBIT_NOTE';
}

export function agingBucket(asOf: string, dueDate: string): AgingBucketKey {
  const overdue = daysBetween(dueDate, asOf);
  for (const bucket of AGING_BUCKETS) {
    if (overdue >= bucket.from && overdue <= bucket.to) return bucket.key;
  }
  return 'over90';
}

export interface AllocationTarget {
  id: string;
  documentNumber: string;
  documentType: SubledgerDocumentType;
  status: SubledgerDocumentStatus;
  accountingStatus: string;
  partyId: string;
  total: string;
  allocatedAmount: string;
  /** Document currency and its rate to base (Phase 8). */
  currency: string;
  exchangeRate: string;
  /** Vendor bills with unreviewed three-way match exceptions cannot be paid. */
  onHold?: boolean;
}

/**
 * Validates a set of allocations against the available source amount and each
 * target's remaining balance. Returns the exact total allocated.
 */
export function validateAllocations(
  allocations: Array<{ documentId: string; amount: string }>,
  targets: Map<string, AllocationTarget>,
  partyId: string,
  available: Money,
  currency: string,
): Money {
  let sum = Money.zero(currency);
  const seen = new Set<string>();
  for (const allocation of allocations) {
    if (seen.has(allocation.documentId)) {
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'A document can only appear once per allocation set.',
      );
    }
    seen.add(allocation.documentId);
    const target = targets.get(allocation.documentId);
    if (!target)
      throw new BusinessRuleError(ErrorCodes.NOT_FOUND, 'Allocation target does not exist.', {
        documentId: allocation.documentId,
      });
    if (target.partyId !== partyId) {
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `${target.documentNumber} belongs to a different party.`,
      );
    }
    if (target.currency !== currency) {
      throw new BusinessRuleError(
        ErrorCodes.CURRENCY_MISMATCH,
        `${target.documentNumber} is in ${target.currency}; settle it with a ${target.currency} payment or credit.`,
      );
    }
    if (!isDebitDocument(target.documentType)) {
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `${target.documentNumber} is a credit note and cannot be settled.`,
      );
    }
    if (
      target.accountingStatus !== 'POSTED' ||
      target.status === 'VOID' ||
      target.status === 'DRAFT'
    ) {
      throw new BusinessRuleError(
        ErrorCodes.JOURNAL_INVALID_STATE,
        `${target.documentNumber} is not an open posted document.`,
      );
    }
    if (target.onHold) {
      throw new BusinessRuleError(
        ErrorCodes.MATCH_EXCEPTION_UNREVIEWED,
        `${target.documentNumber} has unreviewed matching exceptions and cannot be paid.`,
        { documentId: target.id },
      );
    }
    const amount = Money.parse(allocation.amount, currency);
    const remaining = Money.of(target.total, currency).subtract(
      Money.of(target.allocatedAmount, currency),
    );
    if (amount.greaterThan(remaining)) {
      throw new BusinessRuleError(
        ErrorCodes.ALLOCATION_EXCEEDS_BALANCE,
        `${target.documentNumber}: allocation ${amount.toString()} exceeds the open balance ${remaining.toString()}.`,
        { documentId: target.id, remaining: remaining.toString() },
      );
    }
    sum = sum.add(amount);
  }
  if (sum.greaterThan(available)) {
    throw new BusinessRuleError(
      ErrorCodes.ALLOCATION_EXCEEDS_BALANCE,
      `Allocations ${sum.toString()} exceed the available amount ${available.toString()}.`,
      { available: available.toString() },
    );
  }
  return sum;
}
