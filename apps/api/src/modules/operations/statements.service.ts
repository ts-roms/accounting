import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { StatementsQuery } from '@accounting/validation';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database } from '@/database/database.types';

export interface StatementRow {
  /** Stable hash of the normalised statement (`pg_stat_statements.queryid`). */
  queryId: string;
  /** Normalised statement text, parameters replaced by `$n`; capped at 600 chars. */
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
  rows: number;
  /** Buffer cache hit ratio in percent (null when the statement touched no blocks). */
  hitPercent: number | null;
}

export interface StatementsView {
  /** False when `pg_stat_statements` is not installed in this database. */
  available: boolean;
  /** Why it is unavailable and what to run, for the console. */
  reason: string | null;
  /** When the counters were last reset (PostgreSQL 14+), null when unknown. */
  resetAt: string | null;
  orderBy: StatementsQuery['orderBy'];
  rows: StatementRow[];
}

const ORDER: Record<StatementsQuery['orderBy'], string> = {
  total: 'total_exec_time desc',
  mean: 'mean_exec_time desc',
  calls: 'calls desc',
  rows: 'rows desc',
};

/**
 * Database statement statistics for the operations console, read from the
 * `pg_stat_statements` extension of the API's own database and user. The
 * extension must be preloaded by the server (`shared_preload_libraries`) and
 * created once per database; the local compose file does both, managed
 * PostgreSQL usually ships it enabled. Statement text is normalised by the
 * extension (literals become `$1`), so no business data leaves the database.
 */
@Injectable()
export class StatementsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Null when the extension can be queried; otherwise why not. Both halves are
   * needed: CREATE EXTENSION succeeds on a server that does not preload the
   * library, and the view then raises on every read.
   */
  async unavailableReason(): Promise<string | null> {
    const installed = await this.db.execute(
      sql`select 1 from pg_extension where extname = 'pg_stat_statements'`,
    );
    if (installed.rows.length === 0)
      return 'pg_stat_statements is not installed. Add it to shared_preload_libraries, restart PostgreSQL and run CREATE EXTENSION pg_stat_statements in this database.';
    const preload = await this.db.execute<{ setting: string }>(
      sql`select current_setting('shared_preload_libraries', true) as setting`,
    );
    if (!/\bpg_stat_statements\b/.test(preload.rows[0]?.setting ?? ''))
      return 'pg_stat_statements is installed but not preloaded: add it to shared_preload_libraries and restart PostgreSQL.';
    return null;
  }

  async top(query: StatementsQuery): Promise<StatementsView> {
    const reason = await this.unavailableReason();
    if (reason)
      return { available: false, reason, resetAt: null, orderBy: query.orderBy, rows: [] };
    let resetAt: string | null = null;
    try {
      const info = await this.db.execute<{ stats_reset: string | null }>(
        sql`select stats_reset from pg_stat_statements_info`,
      );
      resetAt = info.rows[0]?.stats_reset ? new Date(info.rows[0].stats_reset).toISOString() : null;
    } catch {
      // pg_stat_statements_info arrived in PostgreSQL 14; older servers simply report no reset time.
    }
    const result = await this.db.execute<{
      queryid: string;
      query: string;
      calls: string;
      total_exec_time: string;
      mean_exec_time: string;
      max_exec_time: string;
      rows: string;
      hit_percent: string | null;
    }>(sql`
      select s.queryid::text as queryid,
             left(s.query, 600) as query,
             s.calls::text as calls,
             s.total_exec_time::text as total_exec_time,
             s.mean_exec_time::text as mean_exec_time,
             s.max_exec_time::text as max_exec_time,
             s.rows::text as rows,
             case when s.shared_blks_hit + s.shared_blks_read = 0 then null
                  else round(100.0 * s.shared_blks_hit / (s.shared_blks_hit + s.shared_blks_read), 1)::text
             end as hit_percent
        from pg_stat_statements s
        join pg_database d on d.oid = s.dbid
       where d.datname = current_database()
         and s.userid = (select usesysid from pg_user where usename = current_user)
         and s.query not ilike '%pg_stat_statements%'
       order by ${sql.raw(ORDER[query.orderBy])}
       limit ${query.limit}`);
    return {
      available: true,
      reason: null,
      resetAt,
      orderBy: query.orderBy,
      rows: result.rows.map((r) => ({
        queryId: r.queryid,
        query: r.query,
        calls: Number(r.calls),
        totalMs: Number(r.total_exec_time),
        meanMs: Number(r.mean_exec_time),
        maxMs: Number(r.max_exec_time),
        rows: Number(r.rows),
        hitPercent: r.hit_percent === null ? null : Number(r.hit_percent),
      })),
    };
  }

  /** Zeroes the counters so a fresh window (after a deploy, during a load test) can be read. */
  async reset(): Promise<void> {
    const reason = await this.unavailableReason();
    if (reason) throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, reason);
    await this.db.execute(sql`select pg_stat_statements_reset()`);
  }
}
