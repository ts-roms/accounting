import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';

export const QUEUES = {
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Thin registry over BullMQ queues/workers sharing one Redis connection config.
 * Domain modules register processors through `registerWorker`.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly connection: ConnectionOptions;

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
  }

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
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
    const worker = new Worker<T>(name, processor, { connection: this.connection, concurrency });
    worker.on('failed', (job, err) =>
      this.logger.error({ queue: name, jobId: job?.id, err }, 'Job failed'),
    );
    worker.on('error', (err) => this.logger.error({ queue: name, err }, 'Worker error'));
    this.workers.push(worker);
    return worker;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      ...this.workers.map((w) => w.close()),
      ...[...this.queues.values()].map((q) => q.close()),
    ]);
  }
}
