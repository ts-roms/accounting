import { Money } from '@accounting/money';
import type { DepreciationMethod } from '@accounting/types';

/**
 * Depreciation arithmetic - pure and deterministic. Monthly convention: an
 * asset in service on or before the last day of a period takes a full month;
 * the final month absorbs the rounding residue so accumulated depreciation
 * lands exactly on cost - salvage.
 */

export interface DepreciableAsset {
  cost: string;
  salvageValue: string;
  accumulatedDepreciation: string;
  usefulLifeMonths: number;
  depreciatedMonths: number;
  depreciationMethod: DepreciationMethod;
  decliningRatePercent: string | null;
}

export function bookValue(asset: Pick<DepreciableAsset, 'cost' | 'accumulatedDepreciation'>, currency: string): Money {
  return Money.of(asset.cost, currency).subtract(Money.of(asset.accumulatedDepreciation, currency));
}

/** Depreciation for one more month; zero when the asset is fully depreciated. */
export function monthlyDepreciation(asset: DepreciableAsset, currency: string): Money {
  const cost = Money.of(asset.cost, currency);
  const salvage = Money.of(asset.salvageValue, currency);
  const accumulated = Money.of(asset.accumulatedDepreciation, currency);
  const remainingDepreciable = cost.subtract(salvage).subtract(accumulated);
  if (!remainingDepreciable.isPositive()) return Money.zero(currency);
  const remainingMonths = asset.usefulLifeMonths - asset.depreciatedMonths;
  if (remainingMonths <= 1) return remainingDepreciable;

  if (asset.depreciationMethod === 'DECLINING_BALANCE') {
    const rate = asset.decliningRatePercent ?? String((200 / asset.usefulLifeMonths) * 12); // double-declining default
    const monthly = bookValue(asset, currency).multiply(rate).multiply('0.01').divide('12');
    // Never depreciate below salvage; switch to the straight-line remainder when it would.
    const straight = remainingDepreciable.divide(String(remainingMonths));
    const amount = monthly.greaterThan(straight) ? monthly : straight;
    return amount.greaterThan(remainingDepreciable) ? remainingDepreciable : amount;
  }
  const amount = remainingDepreciable.divide(String(remainingMonths));
  return amount.greaterThan(remainingDepreciable) ? remainingDepreciable : amount;
}

/** Full remaining schedule (for previews); stops when the book value reaches salvage. */
export function schedule(asset: DepreciableAsset, currency: string, maxMonths = 1200): Money[] {
  const out: Money[] = [];
  let current: DepreciableAsset = { ...asset };
  for (let i = 0; i < maxMonths; i++) {
    const amount = monthlyDepreciation(current, currency);
    if (!amount.isPositive()) break;
    out.push(amount);
    current = {
      ...current,
      accumulatedDepreciation: Money.of(current.accumulatedDepreciation, currency).add(amount).toString(),
      depreciatedMonths: current.depreciatedMonths + 1,
    };
  }
  return out;
}

/** Gain (positive) or loss (negative) on disposal. */
export function disposalGainLoss(
  asset: Pick<DepreciableAsset, 'cost' | 'accumulatedDepreciation'>,
  proceeds: string,
  currency: string,
): Money {
  return Money.of(proceeds, currency).subtract(bookValue(asset, currency));
}
