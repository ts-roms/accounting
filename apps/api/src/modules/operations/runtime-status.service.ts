import fs from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Pool } from 'pg';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, PG_POOL, type Database } from '@/database/database.types';
import { schemaStatus } from '@/database/schema-status';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { QueueService, type QueueStats } from '@/modules/jobs/queue.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const APP_VERSION: string = (require('../../../package.json') as { version: string }).version;

export interface MigrationStatus {
  /** Migrations in the bundled journal. */
  known: number;
  /** Applied according to drizzle's migrations table. */
  applied: number;
  /** Journal entries newer than the last applied one (0 = schema is current). */
  pending: string[];
}

export interface RuntimeStatus {
  version: string;
  instanceId: string;
  environment: string;
  startedAt: string;
  uptimeSeconds: number;
  /** True once SIGTERM / app.close() began: readiness fails, in-flight work drains. */
  draining: boolean;
  node: string;
  database: {
    ok: boolean;
    latencyMs: number | null;
    pool: { total: number; idle: number; waiting: number };
  };
  migrations: MigrationStatus | { error: string };
  redis: { ok: boolean; latencyMs: number | null; keyPrefix: string };
  storage: { dir: string; writable: boolean };
  queues: QueueStats[] | null;
  inlineJobs: boolean;
}

/**
 * Runtime health for operators and probes (hardening H8): dependency
 * checks, schema currency (pending migrations block readiness), storage,
 * queue counts and the draining flag used for graceful shutdown. Nothing here
 * touches business data.
 */
@Injectable()
export class RuntimeStatusService implements BeforeApplicationShutdown {
  readonly startedAt = new Date();
  private draining = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: AppConfigService,
    private readonly queues: QueueService,
    private readonly registry: JobRegistryService,
    private readonly runner: JobRunnerService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RuntimeStatusService.name);
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * First shutdown hook: flip readiness so load balancers stop routing here,
   * then let inline jobs finish. Workers and the pool close in their own
   * modules' destroy hooks afterwards.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.draining = true;
    this.logger.info({ signal }, 'Draining: readiness now fails, waiting for inline jobs');
    await this.runner.drain();
  }

  async database(): Promise<RuntimeStatus['database']> {
    const started = Date.now();
    try {
      await this.pool.query('SELECT 1');
      return {
        ok: true,
        latencyMs: Date.now() - started,
        pool: this.poolStats(),
      };
    } catch {
      return { ok: false, latencyMs: null, pool: this.poolStats() };
    }
  }

  private poolStats() {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /** Compares the bundled migration journal with drizzle's migrations table. */
  async migrations(): Promise<MigrationStatus | { error: string }> {
    try {
      return await schemaStatus(this.db);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async redis(): Promise<RuntimeStatus['redis']> {
    const started = Date.now();
    try {
      const pong = await Promise.race([
        this.queues
          .queue('maintenance')
          .client.then((c) => (c as unknown as { ping(): Promise<string> }).ping()),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      if (pong !== 'PONG') throw new Error(pong);
      return { ok: true, latencyMs: Date.now() - started, keyPrefix: this.queues.keyPrefix };
    } catch {
      return { ok: false, latencyMs: null, keyPrefix: this.queues.keyPrefix };
    }
  }

  async storage(): Promise<RuntimeStatus['storage']> {
    const dir = path.resolve(this.config.env.STORAGE_DIR);
    try {
      await fs.mkdir(dir, { recursive: true });
      const probe = path.join(dir, `.probe-${process.pid}`);
      await fs.writeFile(probe, 'ok');
      await fs.unlink(probe);
      return { dir, writable: true };
    } catch {
      return { dir, writable: false };
    }
  }

  async status(): Promise<RuntimeStatus> {
    const [database, migrations, redis, storage, queues] = await Promise.all([
      this.database(),
      this.migrations(),
      this.redis(),
      this.storage(),
      this.queues.stats(),
    ]);
    return {
      version: APP_VERSION,
      instanceId: this.registry.instanceId,
      environment: this.config.env.NODE_ENV,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      draining: this.draining,
      node: process.version,
      database,
      migrations,
      redis,
      storage,
      queues,
      inlineJobs: this.runner.inline,
    };
  }

  /**
   * Readiness: database reachable, schema current and not draining. Redis is
   * deliberately NOT required - the API serves requests without queues.
   */
  async ready(): Promise<{ ready: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    if (this.draining) reasons.push('draining');
    const [database, migrations] = await Promise.all([this.database(), this.migrations()]);
    if (!database.ok) reasons.push('database unreachable');
    if ('error' in migrations) reasons.push(`migrations unknown: ${migrations.error}`);
    else if (migrations.pending.length)
      reasons.push(`pending migrations: ${migrations.pending.join(', ')}`);
    return { ready: reasons.length === 0, reasons };
  }
}
