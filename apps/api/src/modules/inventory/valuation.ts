import { Money } from '@accounting/money';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';

/**
 * Inventory valuation - pure, deterministic functions over exact decimals.
 * Nothing here touches the database; the InventoryService feeds it ordered
 * layers / balances and persists what comes back.
 */

export interface CostLayer {
  id: string;
  quantityRemaining: string;
  unitCost: string;
}

export interface LayerConsumption {
  layerId: string;
  quantity: Money;
  cost: Money;
}

export interface IssueResult {
  consumed: LayerConsumption[];
  totalCost: Money;
  unitCost: Money;
  /** Quantity issued without a cost basis (only when negative stock is allowed). */
  uncovered: Money;
}

/**
 * FIFO: consume layers in the given order (oldest first). The cost of a partial
 * layer is `quantity x unitCost` rounded half-even; a fully consumed layer
 * contributes its exact remaining value so no rounding residue is left behind.
 */
export function consumeFifo(
  layers: readonly CostLayer[],
  quantity: string,
  currency: string,
  fallbackUnitCost: Money | null,
): IssueResult {
  let left = Money.of(quantity, currency);
  if (!left.isPositive()) {
    throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'Issue quantity must be positive.');
  }
  const consumed: LayerConsumption[] = [];
  let totalCost = Money.zero(currency);
  for (const layer of layers) {
    if (!left.isPositive()) break;
    const remaining = Money.of(layer.quantityRemaining, currency);
    if (!remaining.isPositive()) continue;
    const take = remaining.lessThan(left) ? remaining : left;
    const cost = Money.of(layer.unitCost, currency).multiply(take.toString());
    consumed.push({ layerId: layer.id, quantity: take, cost });
    totalCost = totalCost.add(cost);
    left = left.subtract(take);
  }
  if (left.isPositive()) {
    if (!fallbackUnitCost) {
      throw new BusinessRuleError(
        ErrorCodes.INSUFFICIENT_STOCK,
        `Only ${layers.reduce((s, l) => s.add(Money.of(l.quantityRemaining, currency)), Money.zero(currency)).toString()} available; ${quantity} requested.`,
        { requested: quantity },
      );
    }
    totalCost = totalCost.add(fallbackUnitCost.multiply(left.toString()));
  }
  const issued = Money.of(quantity, currency);
  return {
    consumed,
    totalCost,
    unitCost: unitCostOf(totalCost, issued, currency),
    uncovered: left,
  };
}

/**
 * Weighted average: cost = on-hand value x (qty / on-hand qty). Issuing the whole
 * balance relieves its exact value so the balance returns to 0.0000 / 0.0000.
 */
export function issueWeightedAverage(
  balance: { quantityOnHand: string; totalCost: string },
  quantity: string,
  currency: string,
  fallbackUnitCost: Money | null,
): IssueResult {
  const qty = Money.of(quantity, currency);
  if (!qty.isPositive()) {
    throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'Issue quantity must be positive.');
  }
  const onHand = Money.of(balance.quantityOnHand, currency);
  const value = Money.of(balance.totalCost, currency);
  if (qty.greaterThan(onHand)) {
    if (!fallbackUnitCost) {
      throw new BusinessRuleError(
        ErrorCodes.INSUFFICIENT_STOCK,
        `Only ${onHand.toString()} available; ${quantity} requested.`,
        { requested: quantity, available: onHand.toString() },
      );
    }
    const covered = onHand.isPositive() ? value : Money.zero(currency);
    const uncovered = qty.subtract(onHand.isPositive() ? onHand : Money.zero(currency));
    const totalCost = covered.add(fallbackUnitCost.multiply(uncovered.toString()));
    return { consumed: [], totalCost, unitCost: unitCostOf(totalCost, qty, currency), uncovered };
  }
  if (qty.equals(onHand)) {
    return {
      consumed: [],
      totalCost: value,
      unitCost: unitCostOf(value, qty, currency),
      uncovered: Money.zero(currency),
    };
  }
  const average = averageCost(balance, currency);
  const totalCost = average.multiply(qty.toString());
  return { consumed: [], totalCost, unitCost: average, uncovered: Money.zero(currency) };
}

/** Average cost of a balance (0 when empty). */
export function averageCost(
  balance: { quantityOnHand: string; totalCost: string },
  currency: string,
): Money {
  const qty = Money.of(balance.quantityOnHand, currency);
  if (!qty.isPositive()) return Money.zero(currency);
  return unitCostOf(Money.of(balance.totalCost, currency), qty, currency);
}

/** total / quantity rounded half-even to the money scale. */
export function unitCostOf(total: Money, quantity: Money, currency: string): Money {
  if (!quantity.isPositive()) return Money.zero(currency);
  return total.divide(quantity.toString());
}

/** New balance after a receipt: quantities and values add exactly. */
export function applyReceipt(
  balance: { quantityOnHand: string; totalCost: string },
  quantity: string,
  totalCost: Money,
  currency: string,
): { quantityOnHand: Money; totalCost: Money } {
  return {
    quantityOnHand: Money.of(balance.quantityOnHand, currency).add(Money.of(quantity, currency)),
    totalCost: Money.of(balance.totalCost, currency).add(totalCost),
  };
}

/** New balance after an issue; the value never goes below zero on a fully relieved balance. */
export function applyIssue(
  balance: { quantityOnHand: string; totalCost: string },
  quantity: string,
  totalCost: Money,
  currency: string,
): { quantityOnHand: Money; totalCost: Money } {
  const quantityOnHand = Money.of(balance.quantityOnHand, currency).subtract(
    Money.of(quantity, currency),
  );
  let value = Money.of(balance.totalCost, currency).subtract(totalCost);
  // A balance at zero quantity must carry zero value (rounding residue goes to the issue cost).
  if (quantityOnHand.isZero() && !value.isZero()) value = Money.zero(currency);
  return { quantityOnHand, totalCost: value };
}
