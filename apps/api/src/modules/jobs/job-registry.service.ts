import os from 'node:os';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { JobRunStatus, JobTrigger, PaginatedResult } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database } from '@/database/database.types';
import { jobRuns, type JobRun } from '@/database/schema';
import { AppConfigService } from '@/config/app-config.service';
import { QueueService, type QueueName } from './queue.service';

export interface JobDefinition {
  /** Stable name (also the scheduler / lock key), kebab-case. */
  name: string;
  description: string;
  queue: QueueName;
  /** Cron pattern or `every N ms`; null when the job is only run manually or disabled by config. */
  schedule: string | null;
  /** Whether the schedule is active in this process (false when disabled by config or in tests). */
  enabled: boolean;
  run: (ctx: JobContext) => Promise<unknown>;
}

export interface JobContext {
  runId: string;
  trigger: JobTrigger;
  actor: AuthenticatedUser | null;
}

export interface JobView {
  name: string;
  description: string;
  queue: QueueName;
  schedule: string | null;
  enabled: boolean;
  lastRun: JobRun | null;
  /** Consecutive failures since the last success (0 when healthy). */
  failingStreak: number;
}

export interface ExecuteResult {
  run: JobRun;
}

/** Deterministic 64-bit lock id for `pg_try_advisory_lock` from the job name. */
export const lockKey = (name: string): SQL => sql`hashtext(${`job:${name}`})::bigint`;

/**
 * Registry of background jobs (hardening H8). Every scheduled or manual
 * execution goes through `execute`, which (1) takes a session-level advisory
 * lock on the job name so two API instances sharing a database never run the
 * same job concurrently, (2) records a `job_runs` row with the outcome, and
 * (3) reports failures to the operations listeners. Jobs stay idempotent on
 * their own; the lock only removes the concurrency, not the need for it.
 */
@Injectable()
export class JobRegistryService {
  private readonly definitions = new Map<string, JobDefinition>();
  private readonly failureListeners: Array<(run: JobRun, def: JobDefinition) => Promise<void>> = [];
  private readonly finishedListeners: Array<(run: JobRun, def: JobDefinition) => void> = [];
  readonly instanceId = `${os.hostname()}:${process.pid}`;

  /** Queues for which this registry owns the (single) dispatching worker. */
  private readonly workers = new Set<QueueName>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly logger: PinoLogger,
    private readonly queues: QueueService,
    private readonly config: AppConfigService,
  ) {
    this.logger.setContext(JobRegistryService.name);
  }

  /**
   * Registers a repeatable job and, unless disabled (config) or in tests,
   * upserts its BullMQ scheduler. One worker per queue dispatches by job name
   * through `execute`, so several jobs can share a queue without a worker of
   * one job silently swallowing another job's occurrence.
   */
  async scheduleRepeatable(
    definition: Omit<JobDefinition, 'schedule' | 'enabled'> & {
      repeat: { pattern?: string; every?: number } | null;
    },
  ): Promise<void> {
    const { repeat, ...rest } = definition;
    const schedule = repeat?.pattern ?? (repeat?.every ? `every ${repeat.every} ms` : null);
    const enabled = Boolean(repeat) && !this.config.isTest;
    this.register({ ...rest, schedule, enabled });
    if (!enabled) return;
    try {
      this.ensureWorker(rest.queue);
      await this.queues
        .queue(rest.queue)
        .upsertJobScheduler(rest.name, repeat!, { name: rest.name });
    } catch (err) {
      // Redis being unavailable must not prevent the API from serving requests.
      this.logger.warn({ err, job: rest.name }, 'Could not schedule job (is Redis running?)');
    }
  }

  private ensureWorker(queue: QueueName): void {
    if (this.workers.has(queue)) return;
    this.workers.add(queue);
    this.queues.registerWorker(queue, async (job) => {
      if (!this.definitions.has(job.name)) {
        this.logger.warn({ queue, name: job.name }, 'No registered job for scheduled occurrence');
        return;
      }
      await this.execute(job.name, 'SCHEDULED');
    });
  }

  register(definition: JobDefinition): void {
    if (this.definitions.has(definition.name))
      throw new Error(`Job ${definition.name} registered twice`);
    this.definitions.set(definition.name, definition);
  }

  /** Called with every FAILED run (used by the operations module to notify). */
  onFailure(listener: (run: JobRun, def: JobDefinition) => Promise<void>): void {
    this.failureListeners.push(listener);
  }

  /** Called with every terminal run (SUCCEEDED / FAILED / SKIPPED_LOCKED), e.g. for metrics. */
  onFinished(listener: (run: JobRun, def: JobDefinition) => void): void {
    this.finishedListeners.push(listener);
  }

  names(): string[] {
    return [...this.definitions.keys()].sort();
  }

  definition(name: string): JobDefinition {
    const def = this.definitions.get(name);
    if (!def) throw new NotFoundError('Job', name);
    return def;
  }

  /**
   * Runs a job now. Returns the persisted run; a SKIPPED_LOCKED run means
   * another instance holds the job's lock (the caller may retry later).
   */
  async execute(
    name: string,
    trigger: JobTrigger,
    actor: AuthenticatedUser | null = null,
  ): Promise<JobRun> {
    const def = this.definition(name);
    const [started] = await this.db
      .insert(jobRuns)
      .values({
        jobName: name,
        trigger,
        status: 'RUNNING',
        instanceId: this.instanceId,
        triggeredBy: actor?.id ?? null,
      })
      .returning();
    const run = started!;
    const startedAt = Date.now();
    const finish = async (status: JobRunStatus, patch: Partial<typeof jobRuns.$inferInsert>) => {
      const [row] = await this.db
        .update(jobRuns)
        .set({
          status,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          ...patch,
        })
        .where(eq(jobRuns.id, run.id))
        .returning();
      for (const listener of this.finishedListeners) listener(row!, def);
      return row!;
    };

    // The lock lives on one dedicated connection for the whole run; pg
    // releases it automatically if the process dies mid-job.
    return this.db.transaction(async (tx) => {
      const lockResult = await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(${lockKey(name)}) AS locked`,
      );
      const locked = Boolean((lockResult.rows as unknown as Array<{ locked: boolean }>)[0]?.locked);
      if (!locked) {
        this.logger.info({ job: name, trigger }, 'Job skipped: another instance holds the lock');
        return finish('SKIPPED_LOCKED', { error: 'Another instance is running this job' });
      }
      try {
        const result = await def.run({ runId: run.id, trigger, actor });
        const done = await finish('SUCCEEDED', {
          result: result === undefined ? null : (result as object),
        });
        this.logger.info({ job: name, trigger, durationMs: done.durationMs }, 'Job finished');
        return done;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failed = await finish('FAILED', { error: message.slice(0, 4000) });
        this.logger.error({ job: name, trigger, err }, 'Job failed');
        for (const listener of this.failureListeners)
          await listener(failed, def).catch((e: unknown) =>
            this.logger.warn({ err: e, job: name }, 'Job failure listener threw'),
          );
        return failed;
      }
    });
  }

  /** Manual trigger from the operations API: refuses unknown jobs and jobs already running here. */
  async trigger(name: string, actor: AuthenticatedUser): Promise<JobRun> {
    const def = this.definition(name);
    const run = await this.execute(def.name, 'MANUAL', actor);
    if (run.status === 'SKIPPED_LOCKED')
      throw new BusinessRuleError(
        ErrorCodes.JOB_ALREADY_RUNNING,
        `${name} is already running on another instance; try again when it finishes.`,
        { runId: run.id },
      );
    return run;
  }

  async list(): Promise<JobView[]> {
    const names = this.names();
    if (names.length === 0) return [];
    // Latest run per job plus the failing streak since the last success.
    const latest = await this.db.execute(sql`
      SELECT DISTINCT ON (job_name) *
      FROM job_runs
      WHERE status <> 'SKIPPED_LOCKED'
      ORDER BY job_name, started_at DESC
    `);
    const streaks = await this.db.execute(sql`
      SELECT job_name, COUNT(*)::int AS streak
      FROM job_runs r
      WHERE status = 'FAILED'
        AND started_at > COALESCE(
          (SELECT MAX(started_at) FROM job_runs s WHERE s.job_name = r.job_name AND s.status = 'SUCCEEDED'),
          '1970-01-01'
        )
      GROUP BY job_name
    `);
    const lastBy = new Map<string, JobRun>();
    for (const row of latest.rows as unknown as Array<Record<string, unknown>>)
      lastBy.set(row.job_name as string, this.fromRaw(row));
    const streakBy = new Map<string, number>();
    for (const row of streaks.rows as unknown as Array<{ job_name: string; streak: number }>)
      streakBy.set(row.job_name, row.streak);
    return names.map((name) => {
      const def = this.definitions.get(name)!;
      return {
        name,
        description: def.description,
        queue: def.queue,
        schedule: def.schedule,
        enabled: def.enabled,
        lastRun: lastBy.get(name) ?? null,
        failingStreak: streakBy.get(name) ?? 0,
      };
    });
  }

  async runs(query: {
    jobName?: string;
    status?: JobRunStatus;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<JobRun>> {
    const filters: SQL[] = [];
    if (query.jobName) filters.push(eq(jobRuns.jobName, query.jobName));
    if (query.status) filters.push(eq(jobRuns.status, query.status));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(jobRuns)
        .where(where)
        .orderBy(desc(jobRuns.startedAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, jobRuns, where),
    ]);
    return toPaginatedResult(rows, total, query);
  }

  private fromRaw(row: Record<string, unknown>): JobRun {
    return {
      id: row.id as string,
      jobName: row.job_name as string,
      trigger: row.trigger as JobRun['trigger'],
      status: row.status as JobRun['status'],
      instanceId: row.instance_id as string,
      startedAt: new Date(row.started_at as string),
      finishedAt: row.finished_at ? new Date(row.finished_at as string) : null,
      durationMs: (row.duration_ms as number | null) ?? null,
      result: row.result ?? null,
      error: (row.error as string | null) ?? null,
      triggeredBy: (row.triggered_by as string | null) ?? null,
    };
  }
}
