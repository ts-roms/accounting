import { Injectable } from '@nestjs/common';
import type { Env } from './env.schema';

/**
 * Typed access to validated environment configuration. Constructed through a
 * factory in AppConfigModule (never auto-injected), which also makes it trivial
 * to instantiate with a custom `Env` in tests.
 */
@Injectable()
export class AppConfigService {
  constructor(readonly env: Env) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }
}
