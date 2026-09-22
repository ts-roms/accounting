import { z } from 'zod';

/**
 * Environment contract. The application refuses to boot when this fails so
 * misconfiguration surfaces immediately instead of at first request.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Pins the business calendar date (`businessToday()`): default as-of dates, due
   * dates, scheduled jobs. Unset in production; CI and demo stacks pin it to the
   * seed's date so seeded documents never age into dunning steps or new aging
   * buckets. Wall-clock timestamps are unaffected.
   */
  APP_CLOCK_FIXED_DATE: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
      .optional(),
  ),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  API_GLOBAL_PREFIX: z.string().default('api'),
  API_CORS_ORIGINS: z
    .string()
    .default('http://localhost:3006')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

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
  /** Requests per IP per route per window. Users behind one NAT share an IP and a dashboard fires ~20 requests per load, so keep this generous; sign-in has its own tight limit. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  /** Sign-in attempts per IP per minute (brute-force guard); e2e runs raise it. */
  AUTH_LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  AUTH_REFRESH_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
  /** Directory for uploaded attachments (Phase 8); created on first upload. */
  STORAGE_DIR: z.string().trim().min(1).default('./storage'),
  /** AI assistance (Phase 9). HEURISTIC needs no key and is deterministic; ANTHROPIC uses the Messages API. */
  AI_PROVIDER: z.enum(['HEURISTIC', 'ANTHROPIC']).default('HEURISTIC'),
  ANTHROPIC_API_KEY: z.string().trim().optional(),
  AI_MODEL: z.string().trim().min(1).default('claude-sonnet-5'),
  /** Nightly anomaly scan window in days (0 disables the job). */
  AI_ANOMALY_SCAN_DAYS: z.coerce.number().int().min(0).max(365).default(7),
  /**
   * OCR for scanned images in AI intake without a model backend: NONE (images
   * land in review untouched) or TESSERACT (tesseract.js, local WASM engine).
   */
  OCR_PROVIDER: z.enum(['NONE', 'TESSERACT']).default('NONE'),
  /** Tesseract language codes, "+" separated (language data is downloaded once into OCR_CACHE_DIR). */
  OCR_LANGUAGES: z.string().trim().min(3).default('eng'),
  /** Where downloaded language data is cached; defaults to <STORAGE_DIR>/ocr-cache. */
  OCR_CACHE_DIR: z.string().trim().min(1).optional(),
  /** Directory or URL holding <lang>.traineddata for air-gapped hosts (skips the download). */
  OCR_LANG_PATH: z.string().trim().min(1).optional(),
  OCR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),

  /**
   * Nightly accounting schedules (recurring journals, prepayment recognition).
   * Cron pattern in server time; empty string disables the job.
   */
  ACCOUNTING_SCHEDULES_CRON: z.string().trim().default('15 2 * * *'),
  /**
   * Operations (H8). Nightly financial integrity check per company (cron, server
   * time; empty disables); BullMQ key prefix so several deployments (or dev
   * checkouts) can share one Redis without consuming each other's jobs; optional
   * bearer token protecting GET /metrics.
   */
  INTEGRITY_CHECK_CRON: z.string().trim().default('45 3 * * *'),
  QUEUE_PREFIX: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_:-]{1,40}$/)
    .default('accounting'),
  METRICS_TOKEN: z.string().trim().min(16).optional(),

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
  /** Retention (days) applied by the nightly integration-cleanup job; dead letters are kept twice as long. */
  INTEGRATION_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  INTEGRATION_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  SYNC_JOB_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  /** Public base URL of the API for OAuth redirect URIs (e.g. https://api.example.com). */
  OAUTH_REDIRECT_BASE_URL: z.string().trim().url().optional(),
  /** Where OAuth callbacks send the browser back to (the web app). */
  WEB_BASE_URL: z.string().trim().url().default('http://localhost:3006'),

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
