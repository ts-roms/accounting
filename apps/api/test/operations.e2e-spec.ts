import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { runMigrations } from '@/database/migrate';
import { runSeed } from '@/database/seed/seed';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { RuntimeStatusService } from '@/modules/operations/runtime-status.service';
import { StaleJobsService } from '@/modules/operations/stale-jobs.service';

const DB_URL = process.env.DATABASE_URL!;
const ADMIN = { email: 'admin@acme.local', password: 'P@ssw0rd123' };
const AUDITOR = { email: 'auditor@acme.local', password: 'P@ssw0rd123' };
const VIEWER = { email: 'viewer@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Hardening phase 8 - operations & reliability: the job registry (advisory
 * lock, persisted runs, manual trigger), scheduled integrity checks with
 * notifications, readiness / draining, the stale-job sweep, queue dead
 * letters and the metrics endpoint.
 */
describe('Operations (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let auditor: Cookies;
  let viewer: Cookies;
  let companyId: string;
  let registry: JobRegistryService;

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, max: 2 });
    await pool.query(
      'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;',
    );
    await runMigrations(DB_URL);
    await runSeed(DB_URL, {
      adminEmail: ADMIN.email,
      adminPassword: ADMIN.password,
      log: () => undefined,
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    registry = app.get(JobRegistryService);
    admin = await login(ADMIN);
    auditor = await login(AUDITOR);
    viewer = await login(VIEWER);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------- readiness

  it('readiness reports a current schema and flips to 503 while draining', async () => {
    const ready = await http().get('/api/v1/health/ready').expect(200);
    expect(ready.body).toEqual({ status: 'ready', ready: true, reasons: [] });
    const status = await as(http().get('/api/v1/operations/status')).expect(200);
    expect(status.body.migrations.pending).toEqual([]);
    expect(status.body.migrations.applied).toBe(status.body.migrations.known);
    expect(status.body.database.ok).toBe(true);
    expect(status.body.storage.writable).toBe(true);
    expect(status.body.inlineJobs).toBe(true); // tests run jobs inline
    expect(status.body.version).toMatch(/^\d+\.\d+\.\d+/);

    const runtime = app.get(RuntimeStatusService);
    await runtime.beforeApplicationShutdown('SIGTERM');
    const draining = await http().get('/api/v1/health/ready').expect(503);
    expect(draining.body.reasons).toContain('draining');
    // Liveness keeps answering during the drain.
    await http().get('/api/v1/health/live').expect(200);
  });

  // ---------------------------------------------------------------- registry

  it('lists every registered job with its schedule and runs one manually under the advisory lock', async () => {
    const jobs = await as(http().get('/api/v1/operations/jobs')).expect(200);
    const names = jobs.body.map((j: { name: string }) => j.name);
    for (const expected of [
      'session-cleanup',
      'accounting-schedules',
      'depreciation-monthly',
      'integrity-check',
      'stale-jobs-sweep',
      'sync-due',
      'delegation-expiration',
    ])
      expect(names).toContain(expected);
    const cleanup = jobs.body.find((j: { name: string }) => j.name === 'session-cleanup');
    expect(cleanup.schedule).toBe('0 3 * * *');
    expect(cleanup.enabled).toBe(false); // schedulers are off in tests
    expect(cleanup.lastRun).toBeNull();

    const run = await as(http().post('/api/v1/operations/jobs/session-cleanup/run')).expect(201);
    expect(run.body.status).toBe('SUCCEEDED');
    expect(run.body.trigger).toBe('MANUAL');
    expect(run.body.result).toEqual({ deleted: 0 });
    expect(run.body.durationMs).toBeGreaterThanOrEqual(0);

    const after = await as(http().get('/api/v1/operations/jobs')).expect(200);
    expect(after.body.find((j: { name: string }) => j.name === 'session-cleanup').lastRun.id).toBe(
      run.body.id,
    );
    const runs = await as(http().get('/api/v1/operations/job-runs?jobName=session-cleanup')).expect(
      200,
    );
    expect(runs.body.total).toBe(1);
    await as(http().post('/api/v1/operations/jobs/no-such-job/run')).expect(404);

    // The manual run is audited.
    const audit = await as(
      http().get(`/api/v1/audit-logs?action=JOB_RUN&entityId=${run.body.id}`),
    ).expect(200);
    expect(audit.body.total).toBe(1);
  });

  it('a failing job records FAILED with the error, counts the streak and notifies operators', async () => {
    let attempts = 0;
    registry.register({
      name: 'e2e-flaky',
      description: 'fails until the third attempt',
      queue: 'maintenance',
      schedule: null,
      enabled: false,
      run: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`boom ${attempts}`);
        return { attempts };
      },
    });
    const first = await as(http().post('/api/v1/operations/jobs/e2e-flaky/run')).expect(201);
    expect(first.body.status).toBe('FAILED');
    expect(first.body.error).toBe('boom 1');
    await as(http().post('/api/v1/operations/jobs/e2e-flaky/run')).expect(201);
    const listed = await as(http().get('/api/v1/operations/jobs')).expect(200);
    expect(listed.body.find((j: { name: string }) => j.name === 'e2e-flaky').failingStreak).toBe(2);
    const third = await as(http().post('/api/v1/operations/jobs/e2e-flaky/run')).expect(201);
    expect(third.body.status).toBe('SUCCEEDED');
    const healthy = await as(http().get('/api/v1/operations/jobs')).expect(200);
    expect(healthy.body.find((j: { name: string }) => j.name === 'e2e-flaky').failingStreak).toBe(
      0,
    );
    const failedRuns = await as(
      http().get('/api/v1/operations/job-runs?status=FAILED&jobName=e2e-flaky'),
    ).expect(200);
    expect(failedRuns.body.total).toBe(2);
    // Operators (operations.manage) were paged once (throttled by dedupe key).
    const notifications = await as(http().get('/api/v1/notifications?pageSize=50')).expect(200);
    const jobFailed = notifications.body.items.filter(
      (n: { eventType: string; title: string }) =>
        n.eventType === 'JOB_FAILED' && n.title.includes('e2e-flaky'),
    );
    expect(jobFailed).toHaveLength(1);
  });

  it('scheduled jobs stand down while the database is behind the build; readiness says why', async () => {
    // Pretend the newest migration was never applied (the tables exist; only the bookkeeping row goes).
    const { rows: last } = await pool.query<{ id: number; hash: string; created_at: string }>(
      'select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1',
    );
    await pool.query('delete from drizzle.__drizzle_migrations where id = $1', [last[0]!.id]);
    const registry = app.get(JobRegistryService) as unknown as { schemaCheck: unknown };
    registry.schemaCheck = null;
    try {
      const ready = await http().get('/api/v1/health/ready').expect(503);
      expect(ready.body.reasons.join(' ')).toMatch(/migration/i);
      await expect(
        app.get(JobRegistryService).execute('session-cleanup', 'SCHEDULED'),
      ).rejects.toMatchObject({
        code: 'SCHEMA_BEHIND',
      });
      // No run row was written for the skipped tick...
      const runs = await as(
        http().get('/api/v1/operations/job-runs?jobName=session-cleanup'),
      ).expect(200);
      expect(runs.body.items.every((r: { trigger: string }) => r.trigger === 'MANUAL')).toBe(true);
      // ...while an operator's manual run still goes through.
      const manual = await as(
        http().post('/api/v1/operations/jobs/delegation-expiration/run'),
      ).expect(201);
      expect(manual.body.status).toBe('SUCCEEDED');
    } finally {
      await pool.query(
        'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
        [last[0]!.hash, last[0]!.created_at],
      );
      registry.schemaCheck = null;
    }
    // Still draining from the readiness test above, but no longer behind.
    const after = await http().get('/api/v1/health/ready').expect(503);
    expect(after.body.reasons.join(' ')).not.toMatch(/migration/i);
  });

  it('a second execution while the lock is held is SKIPPED_LOCKED; the manual trigger refuses it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    registry.register({
      name: 'e2e-slow',
      description: 'holds the lock until released',
      queue: 'maintenance',
      schedule: null,
      enabled: false,
      run: async () => {
        await gate;
        return 'done';
      },
    });
    const slow = registry.execute('e2e-slow', 'SCHEDULED');
    await new Promise((r) => setTimeout(r, 200));
    const refused = await as(http().post('/api/v1/operations/jobs/e2e-slow/run')).expect(422);
    expect(refused.body.code).toBe('JOB_ALREADY_RUNNING');
    release();
    const first = await slow;
    expect(first.status).toBe('SUCCEEDED');
    const runs = await as(http().get('/api/v1/operations/job-runs?jobName=e2e-slow')).expect(200);
    expect(runs.body.items.map((r: { status: string }) => r.status).sort()).toEqual([
      'SKIPPED_LOCKED',
      'SUCCEEDED',
    ]);
  });

  // ------------------------------------------------------------- stale sweep

  it('the stale sweep fails RUNNING runs of dead instances and never-started queued syncs', async () => {
    const stale = app.get(StaleJobsService);
    const old = new Date(Date.now() - 7 * 3_600_000);
    await pool.query(
      `INSERT INTO job_runs (job_name, trigger, status, instance_id, started_at)
       VALUES ('session-cleanup', 'SCHEDULED', 'RUNNING', 'dead-host:1', $1)`,
      [old],
    );
    // A RUNNING row of THIS instance must survive: it may genuinely still be running.
    await pool.query(
      `INSERT INTO job_runs (job_name, trigger, status, instance_id, started_at)
       VALUES ('session-cleanup', 'SCHEDULED', 'RUNNING', $2, $1)`,
      [old, registry.instanceId],
    );
    const result = await stale.sweep();
    expect(result.staleJobRuns).toBe(1);
    const rows = await pool.query(
      `SELECT status, error FROM job_runs WHERE instance_id = 'dead-host:1'`,
    );
    expect(rows.rows[0].status).toBe('FAILED');
    expect(rows.rows[0].error).toMatch(/owning instance probably died/);
    const mine = await pool.query(
      `SELECT status FROM job_runs WHERE instance_id = $1 AND started_at = $2`,
      [registry.instanceId, old],
    );
    expect(mine.rows[0].status).toBe('RUNNING');
  });

  // --------------------------------------------------------------- integrity

  it('runs the integrity check for a company on demand and stores the outcome', async () => {
    const run = await as(http().post('/api/v1/operations/integrity-runs'))
      .send({ companyId })
      .expect(201);
    expect(['OK', 'WARNING', 'CRITICAL']).toContain(run.body.status);
    expect(run.body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(run.body.findings)).toBe(true);
    // Stored summaries carry only check / severity / count - never figures.
    for (const f of run.body.findings)
      expect(Object.keys(f).sort()).toEqual(['count', 'name', 'severity']);
    const list = await as(
      http().get(`/api/v1/operations/integrity-runs?companyId=${companyId}`),
    ).expect(200);
    expect(list.body.items[0].id).toBe(run.body.id);
    expect(list.body.items[0].companyCode).toBe('ACME');

    // The scheduled job runs every active company and links the runs to itself.
    const job = await as(http().post('/api/v1/operations/jobs/integrity-check/run')).expect(201);
    expect(job.body.status).toBe('SUCCEEDED');
    expect(job.body.result.ACME).toBe(run.body.status);
    const linked = await pool.query(
      `SELECT COUNT(*)::int AS n FROM integrity_runs WHERE job_run_id = $1`,
      [job.body.id],
    );
    expect(linked.rows[0].n).toBeGreaterThanOrEqual(1);

    // Company-level view for the dashboard: the latest stored run, and "Run now" for integrity.check holders.
    const latest = await as(http().get('/api/v1/integrity/runs/latest')).expect(200);
    expect(latest.body.companyCode).toBe('ACME');
    expect(latest.body.jobRunId).toBe(job.body.id);
    const now = await as(http().post('/api/v1/integrity/runs')).send({}).expect(201);
    expect(now.body.companyId).toBe(companyId);
    expect(now.body.status).toBe(run.body.status);
    const after = await as(http().get('/api/v1/integrity/runs/latest')).expect(200);
    expect(after.body.id).toBe(now.body.id);
  });

  // ------------------------------------------------------------------ queues

  it('reports queue statistics per queue (or null without Redis) and the key prefix', async () => {
    const res = await as(http().get('/api/v1/operations/queues')).expect(200);
    expect(typeof res.body.keyPrefix).toBe('string');
    if (res.body.queues) {
      const names = res.body.queues.map((q: { name: string }) => q.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'maintenance',
          'accounting-schedules',
          'integration-sync',
          'webhook-delivery',
        ]),
      );
      for (const q of res.body.queues) expect(typeof q.failed).toBe('number');
      await as(http().get('/api/v1/operations/queues/maintenance/failed')).expect(200);
    }
    await as(http().get('/api/v1/operations/queues/nope/failed')).expect(400);
  });

  // ----------------------------------------------------------------- metrics

  it('exposes Prometheus metrics with route templates, never raw ids', async () => {
    const text = await http().get('/api/v1/metrics').expect(200);
    expect(text.headers['content-type']).toMatch(/text\/plain/);
    expect(text.text).toContain('# TYPE http_requests_total counter');
    expect(text.text).toMatch(
      /http_requests_total\{method="POST",route="\/api\/v1\/operations\/jobs\/:name\/run",status="2xx"\} \d+/,
    );
    expect(text.text).not.toContain('session-cleanup/run');
    expect(text.text).toMatch(/job_runs_total\{job="session-cleanup",status="SUCCEEDED"\} 1/);
    expect(text.text).toMatch(/job_runs_total\{job="e2e-flaky",status="FAILED"\} 2/);
    expect(text.text).toContain('http_request_duration_seconds_bucket');
  });

  // ------------------------------------------------------------- permissions

  it('lists the top database statements from pg_stat_statements and resets the counters (audited)', async () => {
    // Migration 0038 created the extension in this database (the test role is the owner);
    // whether it can be read depends on the server preloading the library (the compose
    // Postgres does, a stock service container does not) - both must be handled cleanly.
    const stats = await as(
      http().get('/api/v1/operations/statements?orderBy=calls&limit=5'),
    ).expect(200);
    if (!stats.body.available) {
      expect(stats.body.reason).toMatch(/shared_preload_libraries/);
      expect(stats.body.rows).toEqual([]);
      const refused = await as(http().post('/api/v1/operations/statements/reset')).expect(422);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      await as(http().post('/api/v1/operations/statements/reset'), auditor).expect(403);
      return;
    }
    expect(stats.body.orderBy).toBe('calls');
    expect(stats.body.rows.length).toBeGreaterThan(0);
    expect(stats.body.rows.length).toBeLessThanOrEqual(5);
    const top = stats.body.rows[0];
    expect(top.calls).toBeGreaterThanOrEqual(stats.body.rows[stats.body.rows.length - 1].calls);
    expect(typeof top.meanMs).toBe('number');
    // Normalised text: parameters are placeholders, never literal values.
    expect(top.query).not.toMatch(/admin@acme.local/);
    await as(http().get('/api/v1/operations/statements?orderBy=slowest')).expect(400);
    await as(http().get('/api/v1/operations/statements'), auditor).expect(200);
    await as(http().post('/api/v1/operations/statements/reset'), auditor).expect(403);
    await as(http().post('/api/v1/operations/statements/reset')).expect(204);
    const after = await as(http().get('/api/v1/operations/statements?orderBy=total')).expect(200);
    expect(after.body.resetAt).not.toBeNull();
    const { rows } = await pool.query(
      "select 1 from audit_logs where action = 'DELETE' and entity_type = 'StatementStats'",
    );
    expect(rows).toHaveLength(1);
  });

  it('auditors read the console; viewers get nothing; only operations.manage runs jobs', async () => {
    await as(http().get('/api/v1/operations/status'), auditor).expect(200);
    await as(http().get('/api/v1/operations/jobs'), auditor).expect(200);
    await as(http().post('/api/v1/operations/jobs/session-cleanup/run'), auditor).expect(403);
    await as(http().get('/api/v1/operations/status'), viewer).expect(403);
    await as(http().get('/api/v1/operations/jobs'), viewer).expect(403);
  });
});
