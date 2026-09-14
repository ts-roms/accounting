import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, or, type SQL } from 'drizzle-orm';
import type { ListExchangeRatesQuery, UpsertExchangeRateInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { companies, exchangeRates, type ExchangeRate } from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { pickRate } from './fx.logic';

const MODULE = 'FX';

/** Organization-wide exchange rates. `rateFor` is the one lookup every module uses. */
@Injectable()
export class ExchangeRatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(organizationId: string, query: ListExchangeRatesQuery): Promise<ExchangeRate[]> {
    const filters: SQL[] = [eq(exchangeRates.organizationId, organizationId)];
    if (query.fromCurrency) filters.push(eq(exchangeRates.fromCurrency, query.fromCurrency));
    if (query.toCurrency) filters.push(eq(exchangeRates.toCurrency, query.toCurrency));
    if (query.from) filters.push(gte(exchangeRates.rateDate, query.from));
    if (query.to) filters.push(lte(exchangeRates.rateDate, query.to));
    return this.db
      .select()
      .from(exchangeRates)
      .where(and(...filters))
      .orderBy(desc(exchangeRates.rateDate), exchangeRates.fromCurrency, exchangeRates.toCurrency)
      .limit(1000);
  }

  /** Insert or replace the quote for a pair and date. */
  async upsert(
    organizationId: string,
    actor: AuthenticatedUser,
    input: UpsertExchangeRateInput,
  ): Promise<ExchangeRate> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(exchangeRates)
        .values({
          organizationId,
          fromCurrency: input.fromCurrency,
          toCurrency: input.toCurrency,
          rateDate: input.rateDate,
          rate: input.rate,
          source: input.source,
          notes: input.notes ?? null,
          createdBy: actor.id,
        })
        .onConflictDoUpdate({
          target: [
            exchangeRates.organizationId,
            exchangeRates.fromCurrency,
            exchangeRates.toCurrency,
            exchangeRates.rateDate,
          ],
          set: {
            rate: input.rate,
            source: input.source,
            notes: input.notes ?? null,
            createdBy: actor.id,
          },
        })
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ExchangeRate',
          entityId: row!.id,
          newValue: {
            pair: `${input.fromCurrency}/${input.toCurrency}`,
            rateDate: input.rateDate,
            rate: input.rate,
          },
          metadata: { actor: actor.email },
        },
        tx,
      );
      return row!;
    });
  }

  async remove(organizationId: string, actor: AuthenticatedUser, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(exchangeRates)
        .where(and(eq(exchangeRates.id, id), eq(exchangeRates.organizationId, organizationId)));
      if (!row) throw new NotFoundError('Exchange rate', id);
      await tx.delete(exchangeRates).where(eq(exchangeRates.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'ExchangeRate',
          entityId: id,
          previousValue: {
            pair: `${row.fromCurrency}/${row.toCurrency}`,
            rateDate: row.rateDate,
            rate: row.rate,
          },
          metadata: { actor: actor.email },
        },
        tx,
      );
    });
  }

  /** Rate in force on a date (direct or inverted); throws when the table has no quote. */
  async rateFor(
    organizationId: string,
    from: string,
    to: string,
    onDate: string,
    executor: DbExecutor = this.db,
  ): Promise<string> {
    if (from === to) return '1';
    const rows = await executor
      .select()
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.organizationId, organizationId),
          lte(exchangeRates.rateDate, onDate),
          or(
            and(eq(exchangeRates.fromCurrency, from), eq(exchangeRates.toCurrency, to)),
            and(eq(exchangeRates.fromCurrency, to), eq(exchangeRates.toCurrency, from)),
          ),
        ),
      );
    const rate = pickRate(rows, from, to, onDate);
    if (!rate) {
      throw new BusinessRuleError(
        ErrorCodes.EXCHANGE_RATE_MISSING,
        `No ${from}/${to} exchange rate on or before ${onDate}.`,
        { fromCurrency: from, toCurrency: to, onDate },
      );
    }
    return rate;
  }

  /** Company base currency and its organization, for callers that only hold a company id. */
  async companyContext(
    companyId: string,
    executor: DbExecutor = this.db,
  ): Promise<{ organizationId: string; baseCurrency: string }> {
    const [row] = await executor
      .select({ organizationId: companies.organizationId, baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!row) throw new NotFoundError('Company', companyId);
    return row;
  }

  /** Resolves a document rate: explicit override wins, else the table on the document date. */
  async documentRate(
    companyId: string,
    currency: string,
    onDate: string,
    override: string | undefined,
    executor: DbExecutor = this.db,
  ): Promise<{ rate: string; baseCurrency: string }> {
    const ctx = await this.companyContext(companyId, executor);
    if (currency === ctx.baseCurrency) return { rate: '1', baseCurrency: ctx.baseCurrency };
    return {
      rate:
        override ??
        (await this.rateFor(ctx.organizationId, currency, ctx.baseCurrency, onDate, executor)),
      baseCurrency: ctx.baseCurrency,
    };
  }
}
