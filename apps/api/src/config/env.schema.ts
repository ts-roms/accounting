import { z } from 'zod';

/**
 * Environment contract. The application refuses to boot when this fails so
 * misconfiguration surfaces immediately instead of at first request.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  API_GLOBAL_PREFIX: z.string().default('api'),
  API_CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .default(7 * 24 * 3600),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),

  RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  /** Directory for uploaded attachments (Phase 8); created on first upload. */
  STORAGE_DIR: z.string().trim().min(1).default('./storage'),
  /** AI assistance (Phase 9). HEURISTIC needs no key and is deterministic; ANTHROPIC uses the Messages API. */
  AI_PROVIDER: z.enum(['HEURISTIC', 'ANTHROPIC']).default('HEURISTIC'),
  ANTHROPIC_API_KEY: z.string().trim().optional(),
  AI_MODEL: z.string().trim().min(1).default('claude-sonnet-5'),
  /** Nightly anomaly scan window in days (0 disables the job). */
  AI_ANOMALY_SCAN_DAYS: z.coerce.number().int().min(0).max(365).default(7),

  /**
   * Integration platform (Prompt #4). The encryption key protects provider
   * credentials, OAuth tokens and webhook secrets at rest; production must set
   * it explicitly (32 bytes hex/base64 or a long passphrase).
   */
  INTEGRATION_ENCRYPTION_KEY: z.string().trim().min(16).optional(),
  /** Run sync / webhook / delivery jobs inline instead of through BullMQ (tests, Redis-less dev). */
  INTEGRATION_INLINE_JOBS: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  /** Public base URL of the API for OAuth redirect URIs (e.g. https://api.example.com). */
  OAUTH_REDIRECT_BASE_URL: z.string().trim().url().optional(),
  /** Where OAuth callbacks send the browser back to (the web app). */
  WEB_BASE_URL: z.string().trim().url().default('http://localhost:3000'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
