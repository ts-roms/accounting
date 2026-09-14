import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Pool } from 'pg';
import Redis from 'ioredis';
import { Public } from '@/common/decorators/public.decorator';
import { AppConfigService } from '@/config/app-config.service';
import { PG_POOL } from '@/database/database.types';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly config: AppConfigService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.database(), () => this.redis()]);
  }

  /** Liveness: process is up. Readiness (above) additionally checks dependencies. */
  @Public()
  @Get('live')
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  private async database(): Promise<HealthIndicatorResult> {
    const started = Date.now();
    await this.pool.query('SELECT 1');
    return { database: { status: 'up', latencyMs: Date.now() - started } };
  }

  private async redis(): Promise<HealthIndicatorResult> {
    const client = new Redis(this.config.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    const started = Date.now();
    try {
      await client.connect();
      const pong = await client.ping();
      if (pong !== 'PONG') throw new Error(`Unexpected reply: ${pong}`);
      return { redis: { status: 'up', latencyMs: Date.now() - started } };
    } finally {
      client.disconnect();
    }
  }
}
