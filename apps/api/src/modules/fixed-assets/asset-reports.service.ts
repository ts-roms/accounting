import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { AssetRollforwardQuery } from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import { assetCategories, assetEvents, fixedAssets, leaseEvents, leases } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';

export interface RollforwardSide {
  opening: string;
  additions: string;
  depreciation: string;
  impairment: string;
  revaluation: string;
  disposals: string;
  closing: string;
}

export interface RollforwardGroup {
  categoryId: string | null;
  categoryCode: string;
  categoryName: string;
  /** Assets carried at the start / added / disposed in the window / carried at the end. */
  counts: { opening: number; additions: number; disposals: number; closing: number };
  cost: RollforwardSide;
  accumulated: RollforwardSide;
  bookValue: { opening: string; closing: string };
}

export interface AssetRollforward {
  from: string;
  to: string;
  currency: string;
  groups: RollforwardGroup[];
  totals: Omit<RollforwardGroup, 'categoryId' | 'categoryCode' | 'categoryName'>;
}

const ROU_CODE = 'ROU';

interface Replayed {
  key: string;
  categoryId: string | null;
  categoryCode: string;
  categoryName: string;
  assetKey: string;
  date: string;
  cost: Money;
  accumulated: Money;
  kind: keyof Omit<RollforwardSide, 'opening' | 'closing'>;
  /** Disposal-type events also change the asset count. */
  countDelta: number;
}

/**
 * Register rollforward (Prompt #13). The asset events are replayed per asset
 * in date order so that every event yields an exact cost / accumulated
 * effect (disposals release whatever was accumulated by then, splits move
 * both sides); the window then buckets those effects into opening,
 * movements by kind and closing per category. Right-of-use assets from the
 * lease register are shown as their own group so the note ties to the
 * balance sheet. Nothing is stored and the ledger is never re-derived.
 */
@Injectable()
export class AssetReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
  ) {}

  async rollforward(companyId: string, query: AssetRollforwardQuery): Promise<AssetRollforward> {
    const currency = await this.accounts.companyCurrency(companyId);
    const zero = Money.zero(currency);
    const effects: Replayed[] = [
      ...(await this.assetEffects(companyId, query.categoryId, currency)),
      ...(query.categoryId ? [] : await this.leaseEffects(companyId, currency)),
    ];
    const groups = new Map<
      string,
      RollforwardGroup & {
        c: Record<keyof RollforwardSide, Money>;
        a: Record<keyof RollforwardSide, Money>;
        openingAssets: Set<string>;
        closingAssets: Set<string>;
        addedAssets: Set<string>;
        disposedAssets: Set<string>;
      }
    >();
    const side = () => ({
      opening: zero,
      additions: zero,
      depreciation: zero,
      impairment: zero,
      revaluation: zero,
      disposals: zero,
      closing: zero,
    });
    for (const e of effects) {
      let g = groups.get(e.key);
      if (!g) {
        g = {
          categoryId: e.categoryId,
          categoryCode: e.categoryCode,
          categoryName: e.categoryName,
          counts: { opening: 0, additions: 0, disposals: 0, closing: 0 },
          cost: side() as unknown as RollforwardSide,
          accumulated: side() as unknown as RollforwardSide,
          bookValue: { opening: '0', closing: '0' },
          c: side(),
          a: side(),
          openingAssets: new Set(),
          closingAssets: new Set(),
          addedAssets: new Set(),
          disposedAssets: new Set(),
        };
        groups.set(e.key, g);
      }
      if (e.date < query.from) {
        g.c.opening = g.c.opening.add(e.cost);
        g.a.opening = g.a.opening.add(e.accumulated);
        if (e.countDelta > 0) g.openingAssets.add(e.assetKey);
        if (e.countDelta < 0) g.openingAssets.delete(e.assetKey);
      } else if (e.date <= query.to) {
        g.c[e.kind] = g.c[e.kind].add(e.cost);
        g.a[e.kind] = g.a[e.kind].add(e.accumulated);
        if (e.countDelta > 0) g.addedAssets.add(e.assetKey);
        if (e.countDelta < 0) g.disposedAssets.add(e.assetKey);
      }
    }
    const finish = (g: ReturnType<typeof groups.get> & object): RollforwardGroup => {
      const close = (s: Record<keyof RollforwardSide, Money>) =>
        s.opening
          .add(s.additions)
          .add(s.depreciation)
          .add(s.impairment)
          .add(s.revaluation)
          .add(s.disposals);
      g.c.closing = close(g.c);
      g.a.closing = close(g.a);
      const str = (s: Record<keyof RollforwardSide, Money>): RollforwardSide => ({
        opening: s.opening.toString(),
        additions: s.additions.toString(),
        depreciation: s.depreciation.toString(),
        impairment: s.impairment.toString(),
        revaluation: s.revaluation.toString(),
        disposals: s.disposals.toString(),
        closing: s.closing.toString(),
      });
      const closingAssets = new Set([...g.openingAssets, ...g.addedAssets]);
      for (const d of g.disposedAssets) closingAssets.delete(d);
      return {
        categoryId: g.categoryId,
        categoryCode: g.categoryCode,
        categoryName: g.categoryName,
        counts: {
          opening: g.openingAssets.size,
          additions: g.addedAssets.size,
          disposals: g.disposedAssets.size,
          closing: closingAssets.size,
        },
        cost: str(g.c),
        accumulated: str(g.a),
        bookValue: {
          opening: g.c.opening.subtract(g.a.opening).toString(),
          closing: g.c.closing.subtract(g.a.closing).toString(),
        },
      };
    };
    const out = [...groups.values()]
      .map(finish)
      .sort((x, y) => x.categoryCode.localeCompare(y.categoryCode));
    const sum = (pick: (g: RollforwardGroup) => string) =>
      Money.sum(
        out.map((g) => Money.of(pick(g), currency)),
        currency,
      ).toString();
    const sideTotals = (which: 'cost' | 'accumulated'): RollforwardSide => ({
      opening: sum((g) => g[which].opening),
      additions: sum((g) => g[which].additions),
      depreciation: sum((g) => g[which].depreciation),
      impairment: sum((g) => g[which].impairment),
      revaluation: sum((g) => g[which].revaluation),
      disposals: sum((g) => g[which].disposals),
      closing: sum((g) => g[which].closing),
    });
    return {
      from: query.from,
      to: query.to,
      currency,
      groups: out,
      totals: {
        counts: {
          opening: out.reduce((n, g) => n + g.counts.opening, 0),
          additions: out.reduce((n, g) => n + g.counts.additions, 0),
          disposals: out.reduce((n, g) => n + g.counts.disposals, 0),
          closing: out.reduce((n, g) => n + g.counts.closing, 0),
        },
        cost: sideTotals('cost'),
        accumulated: sideTotals('accumulated'),
        bookValue: {
          opening: sum((g) => g.bookValue.opening),
          closing: sum((g) => g.bookValue.closing),
        },
      },
    };
  }

  /** Replays the fixed-asset events per asset into exact cost / accumulated effects. */
  private async assetEffects(
    companyId: string,
    categoryId: string | undefined,
    currency: string,
  ): Promise<Replayed[]> {
    const assets = await this.db
      .select({
        id: fixedAssets.id,
        categoryId: fixedAssets.categoryId,
        categoryCode: assetCategories.code,
        categoryName: assetCategories.name,
      })
      .from(fixedAssets)
      .innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
      .where(
        and(
          eq(fixedAssets.companyId, companyId),
          ...(categoryId ? [eq(fixedAssets.categoryId, categoryId)] : []),
        ),
      );
    if (assets.length === 0) return [];
    const byAsset = new Map(assets.map((a) => [a.id, a]));
    const events = await this.db
      .select()
      .from(assetEvents)
      .where(
        inArray(
          assetEvents.assetId,
          assets.map((a) => a.id),
        ),
      )
      .orderBy(asc(assetEvents.assetId), asc(assetEvents.eventDate), asc(assetEvents.createdAt));
    const zero = Money.zero(currency);
    const out: Replayed[] = [];
    const running = new Map<string, { cost: Money; accumulated: Money }>();
    for (const e of events) {
      const asset = byAsset.get(e.assetId)!;
      const state = running.get(e.assetId) ?? { cost: zero, accumulated: zero };
      const amount = Money.of(e.amount, currency);
      const base = {
        key: `CAT:${asset.categoryId}`,
        categoryId: asset.categoryId,
        categoryCode: asset.categoryCode,
        categoryName: asset.categoryName,
        assetKey: e.assetId,
        date: e.eventDate,
      };
      let cost = zero;
      let accumulated = zero;
      let kind: Replayed['kind'] = 'additions';
      let countDelta = 0;
      switch (e.eventType) {
        case 'CAPITALIZATION':
          cost = amount;
          kind = 'additions';
          countDelta = 1;
          break;
        case 'REVALUATION':
          cost = amount;
          kind = 'revaluation';
          break;
        case 'DEPRECIATION':
          accumulated = amount;
          kind = 'depreciation';
          break;
        case 'IMPAIRMENT':
          accumulated = amount;
          kind = 'impairment';
          break;
        case 'DISPOSAL':
        case 'WRITE_OFF':
          cost = state.cost.negate();
          accumulated = state.accumulated.negate();
          kind = 'disposals';
          countDelta = -1;
          break;
        case 'SPLIT': {
          // amount = signed cost effect; accumulated after = cost after - book value after.
          const costAfter = state.cost.add(amount);
          const accumulatedAfter = costAfter.subtract(Money.of(e.bookValueAfter, currency));
          cost = amount;
          accumulated = accumulatedAfter.subtract(state.accumulated);
          if (amount.isPositive()) {
            kind = 'additions';
            countDelta = 1;
          } else {
            kind = 'disposals';
            countDelta = costAfter.isZero() ? -1 : 0;
          }
          break;
        }
        default:
          continue; // TRANSFER: no carrying effect
      }
      running.set(e.assetId, {
        cost: state.cost.add(cost),
        accumulated: state.accumulated.add(accumulated),
      });
      out.push({ ...base, cost, accumulated, kind, countDelta });
    }
    return out;
  }

  /** Right-of-use assets: commencement adds cost, runs add accumulated, remeasurement moves cost, termination releases both. */
  private async leaseEffects(companyId: string, currency: string): Promise<Replayed[]> {
    const rows = await this.db
      .select({ event: leaseEvents, classification: leases.classification })
      .from(leaseEvents)
      .innerJoin(leases, eq(leases.id, leaseEvents.leaseId))
      .where(and(eq(leaseEvents.companyId, companyId), eq(leases.classification, 'FINANCE')))
      .orderBy(asc(leaseEvents.leaseId), asc(leaseEvents.eventDate), asc(leaseEvents.createdAt));
    const zero = Money.zero(currency);
    const out: Replayed[] = [];
    const running = new Map<string, { cost: Money; accumulated: Money }>();
    for (const { event: e } of rows) {
      const state = running.get(e.leaseId) ?? { cost: zero, accumulated: zero };
      const change = Money.of(e.rouChange, currency);
      let cost = zero;
      let accumulated = zero;
      let kind: Replayed['kind'] = 'additions';
      let countDelta = 0;
      switch (e.eventType) {
        case 'COMMENCEMENT':
          cost = change;
          kind = 'additions';
          countDelta = 1;
          break;
        case 'DEPRECIATION':
          // rouChange is the (negative) carrying effect; accumulated moves the other way.
          accumulated = change.negate();
          kind = 'depreciation';
          break;
        case 'REMEASUREMENT':
          cost = change;
          kind = 'revaluation';
          break;
        case 'TERMINATION':
          cost = state.cost.negate();
          accumulated = state.accumulated.negate();
          kind = 'disposals';
          countDelta = -1;
          break;
        default:
          continue; // INTEREST / PAYMENT: liability only
      }
      running.set(e.leaseId, {
        cost: state.cost.add(cost),
        accumulated: state.accumulated.add(accumulated),
      });
      out.push({
        key: ROU_CODE,
        categoryId: null,
        categoryCode: ROU_CODE,
        categoryName: 'Right-of-use assets (leases)',
        assetKey: e.leaseId,
        date: e.eventDate,
        cost,
        accumulated,
        kind,
        countDelta,
      });
    }
    return out;
  }
}
