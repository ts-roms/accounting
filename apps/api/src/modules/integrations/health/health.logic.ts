import type { IntegrationHealthStatus, IntegrationStatus } from '@accounting/types';

/**
 * Health score from measured conditions only. Each deduction names its
 * cause so the UI can show *why* an integration is degraded. No heuristics
 * beyond these rules, no AI.
 */
export interface HealthSignals {
  status: IntegrationStatus;
  now: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  failureCount: number;
  credentialsExpireAt: Date | null;
  oauthStatus: string | null;
  /** From integration_logs over the last 24h. */
  failures24h: number;
  successes24h: number;
  avgLatencyMs: number | null;
  /** Outbound webhook deliveries linked to this integration, last 24h. */
  webhookExhausted24h: number;
  webhookDelivered24h: number;
  providerRateLimited: boolean;
  /** Scheduled sync overdue by more than one interval. */
  syncOverdue: boolean;
}

export interface HealthReport {
  score: number;
  status: IntegrationHealthStatus;
  deductions: Array<{ code: string; points: number; detail: string }>;
  connection: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'DISABLED' | 'CONNECTING';
  webhookHealth: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'NONE';
  credentialExpiry: {
    expiresAt: Date | null;
    daysLeft: number | null;
    state: 'OK' | 'EXPIRING' | 'EXPIRED' | 'NONE';
  };
  apiLatencyMs: number | null;
  rateLimitState: 'OK' | 'THROTTLED';
}

const DAY = 24 * 3600 * 1000;

export function computeHealth(s: HealthSignals): HealthReport {
  const deductions: HealthReport['deductions'] = [];
  const ded = (code: string, points: number, detail: string) =>
    deductions.push({ code, points, detail });

  if (s.status === 'DISABLED') ded('DISABLED', 100, 'Integration is disabled');
  else if (s.status === 'DISCONNECTED') ded('DISCONNECTED', 60, 'Not connected');
  else if (s.status === 'ERROR') ded('ERROR', 40, 'Last operation failed');
  else if (s.status === 'CONNECTING') ded('CONNECTING', 20, 'Connection in progress');

  if (s.lastFailureAt && (!s.lastSuccessAt || s.lastFailureAt > s.lastSuccessAt))
    ded('RECENT_FAILURE', 15, 'Most recent operation failed');
  if (s.failureCount > 0)
    ded(
      'CONSECUTIVE_FAILURES',
      Math.min(s.failureCount * 10, 30),
      `${s.failureCount} consecutive failure(s)`,
    );

  const total24 = s.failures24h + s.successes24h;
  if (total24 >= 5) {
    const ratio = s.failures24h / total24;
    if (ratio >= 0.5)
      ded('FAILURE_RATE', 25, `${Math.round(ratio * 100)}% of operations failed in 24h`);
    else if (ratio >= 0.2)
      ded('FAILURE_RATE', 10, `${Math.round(ratio * 100)}% of operations failed in 24h`);
  }

  let credState: HealthReport['credentialExpiry']['state'] = 'NONE';
  let daysLeft: number | null = null;
  if (s.credentialsExpireAt) {
    daysLeft = Math.floor((s.credentialsExpireAt.getTime() - s.now.getTime()) / DAY);
    if (daysLeft < 0) {
      credState = 'EXPIRED';
      ded('CREDENTIALS_EXPIRED', 40, 'Credentials have expired');
    } else if (daysLeft <= 7) {
      credState = 'EXPIRING';
      ded('CREDENTIALS_EXPIRING', 15, `Credentials expire in ${daysLeft} day(s)`);
    } else credState = 'OK';
  }
  if (s.oauthStatus === 'EXPIRED' || s.oauthStatus === 'REVOKED' || s.oauthStatus === 'FAILED')
    ded('OAUTH', 40, `OAuth connection is ${s.oauthStatus.toLowerCase()}`);

  let webhookHealth: HealthReport['webhookHealth'] = 'NONE';
  const wh = s.webhookExhausted24h + s.webhookDelivered24h;
  if (wh > 0) {
    const bad = s.webhookExhausted24h / wh;
    if (s.webhookExhausted24h > 0 && bad >= 0.5) {
      webhookHealth = 'UNHEALTHY';
      ded(
        'WEBHOOKS_FAILING',
        20,
        `${s.webhookExhausted24h} webhook delivery(ies) exhausted in 24h`,
      );
    } else if (s.webhookExhausted24h > 0) {
      webhookHealth = 'DEGRADED';
      ded(
        'WEBHOOKS_DEGRADED',
        10,
        `${s.webhookExhausted24h} webhook delivery(ies) exhausted in 24h`,
      );
    } else webhookHealth = 'HEALTHY';
  }

  if (s.avgLatencyMs !== null && s.avgLatencyMs > 5000)
    ded('LATENCY', 10, `Average latency ${s.avgLatencyMs} ms`);
  else if (s.avgLatencyMs !== null && s.avgLatencyMs > 2000)
    ded('LATENCY', 5, `Average latency ${s.avgLatencyMs} ms`);
  if (s.providerRateLimited) ded('RATE_LIMITED', 10, 'Provider rate limit reached');
  if (s.syncOverdue) ded('SYNC_OVERDUE', 15, 'Scheduled sync is overdue');

  const score = Math.max(0, 100 - deductions.reduce((sum, d) => sum + d.points, 0));
  const status: IntegrationHealthStatus =
    s.status === 'DISABLED'
      ? 'UNKNOWN'
      : score >= 80
        ? 'HEALTHY'
        : score >= 50
          ? 'DEGRADED'
          : 'UNHEALTHY';
  return {
    score,
    status,
    deductions,
    connection: s.status === 'SYNCING' ? 'CONNECTED' : s.status,
    webhookHealth,
    credentialExpiry: { expiresAt: s.credentialsExpireAt, daysLeft, state: credState },
    apiLatencyMs: s.avgLatencyMs,
    rateLimitState: s.providerRateLimited ? 'THROTTLED' : 'OK',
  };
}
