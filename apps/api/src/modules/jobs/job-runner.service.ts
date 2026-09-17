import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { JobsOptions } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';
import { JobRegistryService } from './job-registry.service';
import { QueueService, type QueueName } from './queue.service';

export type JobHandler<T> = (data: T, meta: { jobId: string; attempt: number }) => Promise<unknown>;

/**
 * Thin layer over BullMQ used by every integration worker. In inline mode
 * (tests, Redis-less development) handlers run immediately in-process with
 * the same semantics, so the e2e suites exercise the real sync / delivery
 * code without a broker. Handlers must be idempotent either way.
 */
@Injectable()
export class JobRunnerService implements OnModuleInit {
  private readonly handlers = new Map<string, JobHandler<unknown>>();
  private readonly registeredQueues = new Set<QueueName>();
  readonly inline: boolean;
  private redisAvailable = true;
  /** Inline executions still in flight (tests await this to observe results). */
  private pending: Promise<unknown>[] = [];
  /** Inline stand-in for BullMQ's job-id dedupe: a waiting or running id is not added twice. */
  private readonly inlineIds = new Set<string>();

  constructor(
    private readonly queues: QueueService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    private readonly registry: JobRegistryService,
  ) {
    this.logger.setContext(JobRunnerService.name);
    this.inline = config.env.INTEGRATION_INLINE_JOBS || config.isTest;
  }

  onModuleInit(): void {
    if (this.inline) this.logger.info('Integration jobs run inline (INTEGRATION_INLINE_JOBS)');
  }

  /** Registers a named handler on a queue; one worker per queue is created lazily. */
  register<T>(queue: QueueName, name: string, handler: JobHandler<T>, concurrency = 2): void {
    this.handlers.set(`${queue}:${name}`, handler as JobHandler<unknown>);
    if (this.inline || this.registeredQueues.has(queue)) return;
    this.registeredQueues.add(queue);
    try {
      this.queues.registerWorker(
        queue,
        async (job) => {
          const h = this.handlers.get(`${queue}:${job.name}`);
          if (!h) {
            this.logger.warn({ queue, name: job.name }, 'No handler for job');
            return;
          }
          await h(job.data, { jobId: String(job.id), attempt: job.attemptsMade + 1 });
        },
        concurrency,
      );
    } catch (err) {
      this.redisAvailable = false;
      this.logger.warn({ err, queue }, 'Could not start worker (is Redis running?)');
    }
  }

  /** Enqueues (or runs inline). Returns the queue job id when queued. */
  async enqueue<T>(
    queue: QueueName,
    name: string,
    data: T,
    options: JobsOptions = {},
  ): Promise<string | null> {
    if (this.inline) {
      const h = this.handlers.get(`${queue}:${name}`);
      if (!h) throw new Error(`No inline handler for ${queue}:${name}`);
      const id = options.jobId ? `${queue}:${options.jobId}` : null;
      if (id) {
        if (this.inlineIds.has(id)) return null;
        this.inlineIds.add(id);
      }
      const run = (async () => {
        if (options.delay) await new Promise((r) => setTimeout(r, Math.min(options.delay!, 50)));
        await h(data, { jobId: options.jobId ?? `inline-${Date.now()}`, attempt: 1 });
      })().catch((err: unknown) => this.logger.error({ err, queue, name }, 'Inline job failed'));
      this.pending.push(run);
      void run.finally(() => {
        this.pending = this.pending.filter((p) => p !== run);
        if (id) this.inlineIds.delete(id);
      });
      return null;
    }
    try {
      const job = await this.queues
        .queue(queue)
        .add(name, data as object, { attempts: 1, ...options });
      return String(job.id);
    } catch (err) {
      this.redisAvailable = false;
      this.logger.error({ err, queue, name }, 'Could not enqueue job');
      throw err;
    }
  }

  /**
   * Repeatable job (cron or every-ms); no-op inline. The occurrence runs
   * through the job registry (advisory lock + job_runs row), so it also shows
   * up in the operations console and can be triggered manually.
   */
  async schedule(
    queue: QueueName,
    name: string,
    repeat: { pattern?: string; every?: number },
    data: object = {},
    description = name,
  ): Promise<void> {
    const key = `${queue}:${name}`;
    const handler = this.handlers.get(key);
    if (handler) {
      this.registry.register({
        name,
        description,
        queue,
        schedule: repeat.pattern ?? (repeat.every ? `every ${repeat.every} ms` : null),
        enabled: !this.inline,
        run: () => handler(data, { jobId: 'registry', attempt: 1 }),
      });
      this.handlers.set(key, async () => {
        await this.registry.execute(name, 'SCHEDULED');
      });
    }
    if (this.inline) return;
    try {
      await this.queues.queue(queue).upsertJobScheduler(name, repeat, { name, data });
    } catch (err) {
      this.redisAvailable = false;
      this.logger.warn({ err, queue, name }, 'Could not schedule repeatable job');
    }
  }

  /** Waits for inline executions (test helper; resolves immediately in queue mode). */
  async drain(): Promise<void> {
    while (this.pending.length) await Promise.allSettled([...this.pending]);
  }

  get healthy(): boolean {
    return this.inline || this.redisAvailable;
  }
}
