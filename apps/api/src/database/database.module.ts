import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';
import * as schema from './schema';
import { DRIZZLE, PG_POOL, type Database } from './database.types';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new Pool({
          connectionString: config.env.DATABASE_URL,
          max: config.env.DATABASE_POOL_MAX,
          // Always work with timezone-aware timestamps; pg returns them as Date.
          application_name: 'accounting-api',
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL, PinoLogger],
      useFactory: (pool: Pool, logger: PinoLogger): Database => {
        logger.setContext('Drizzle');
        return drizzle(pool, {
          schema,
          logger: {
            logQuery: (query, params) => logger.trace({ query, params }, 'sql'),
          },
        });
      },
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
