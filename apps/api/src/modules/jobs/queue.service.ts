import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';

export const QUEUES = {
  MAINTENANCE: 'maintenance',
  /** Recurring journals and prepayment recognition (Accounting core). */
  ACCOUNTING_SCHEDULES: 'accounting-schedules',
  // Integration platform (Prompt #4)
  INTEGRATION_SYNC: 'integration-sync',
  WEBHOOK_DELIVERY: 'webhook-delivery',
  WEBHOOK_INBOUND: 'webhook-inbound',
  INTEGRATION_MAINTENANCE: 'integration-maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const QUEUE_NAMES = Object.values(QUEUES) as QueueName[];

export interface QueueStats {
  name: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: boolean;
  /** Repeatable schedulers registered on the queue (name + next run). */
  schedulers: Array<{
    key: string;
    name: string | null;
    pattern: string | null;
    every: string | null;
    next: string | null;
  }>;
}

export interface FailedJobView {
  id: string;
  name: string;
  data: unknown;
  attemptsMade: number;
  failedReason: string | null;
  stacktrace: string[];
  timestamp: string;
  finishedOn: string | null;
}

/**
 * Thin registry over BullMQ queues/workers sharing one Redis connection config.
 * Domain modules register processors through `registerWorker`. Every key is
 * namespaced by `QUEUE_PREFIX` (H8) so deployments / dev checkouts that share a
 * Redis never consume each other's jobs.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly connection: ConnectionOptions;
  private readonly prefix: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QueueService.name);
    const url = new URL(config.env.REDIS_URL);
    this.connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username || undefined,
      password: url.password || undefined,
      db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    };
    this.prefix = config.env.QUEUE_PREFIX;
  }

  get keyPrefix(): string {
    return this.prefix;
  }

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        prefix: this.prefix,
        defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500, attempts: 3 },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  registerWorker<T = unknown>(
    name: QueueName,
    processor: Processor<T>,
    concurrency = 1,
  ): Worker<T> {
    const worker = new Worker<T>(name, processor, {
      connection: this.connection,
      prefix: this.prefix,
      concurrency,
    });
    worker.on('failed', (job, err) =>
      this.logger.error({ queue: name, jobId: job?.id, err }, 'Job failed'),
    );
    worker.on('error', (err) => this.logger.error({ queue: name, err }, 'Worker error'));
    this.workers.push(worker);
    return worker;
  }

  // ------------------------------------------------------------ inspection (H8)

  /** Counts and schedulers per queue; `null` when Redis is unreachable. */
  async stats(): Promise<QueueStats[] | null> {
    try {
      return await Promise.all(
        QUEUE_NAMES.map(async (name) => {
          const q = this.queue(name);
          const [counts, paused, schedulers] = await Promise.all([
            q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
            q.isPaused(),
            q.getJobSchedulers(0, 50),
          ]);
          return {
            name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            completed: counts.completed ?? 0,
            paused,
            schedulers: schedulers.map((s) => ({
              key: s.key,
              name: s.name ?? null,
              pattern: s.pattern ?? null,
              every: s.every != null ? String(s.every) : null,
              next: s.next ? new Date(s.next).toISOString() : null,
            })),
          };
        }),
      );
    } catch (err) {
      this.logger.warn({ err }, 'Queue inspection unavailable (is Redis running?)');
      return null;
    }
  }

  /** Dead letter: failed jobs of one queue, newest first. */
  async failed(name: QueueName, limit = 50): Promise<FailedJobView[]> {
    const jobs = await this.queue(name).getFailed(0, Math.max(0, limit - 1));
    return jobs
      .map((j) => ({
        id: String(j.id),
        name: j.name,
        data: j.data as unknown,
        attemptsMade: j.attemptsMade,
        failedReason: j.failedReason ?? null,
        stacktrace: (j.stacktrace ?? []).slice(0, 3),
        timestamp: new Date(j.timestamp).toISOString(),
        finishedOn: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
      }))
      .sort((a, b) => ((a.finishedOn ?? a.timestamp) < (b.finishedOn ?? b.timestamp) ? 1 : -1));
  }

  /** Re-queues one failed job (or every failed job when `jobId` is omitted). Returns how many were retried. */
  async retryFailed(name: QueueName, jobId?: string): Promise<number> {
    const q = this.queue(name);
    if (jobId) {
      const job = await q.getJob(jobId);
      if (!job) return 0;
      await job.retry('failed');
      return 1;
    }
    const failed = await q.getFailed(0, 499);
    await Promise.all(failed.map((j) => j.retry('failed')));
    return failed.length;
  }

  /** Removes one failed job for good. Returns whether it existed. */
  async discardFailed(name: QueueName, jobId: string): Promise<boolean> {
    const job = await this.queue(name).getJob(jobId);
    if (!job) return false;
    await job.remove();
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      ...this.workers.map((w) => w.close()),
      ...[...this.queues.values()].map((q) => q.close()),
    ]);
  }
}
