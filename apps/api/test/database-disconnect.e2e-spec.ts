import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createPool } from '@/database/pool';

const DB_URL = process.env.DATABASE_URL!;
const APP = 'accounting-api-disconnect-test';

/**
 * A connection the server drops while a request holds it (failover, admin
 * kill, idle-in-transaction timeout) must fail that request only. Before the
 * per-client listener in `createPool`, the dropped client emitted an unhandled
 * 'error' event and the API process exited (57P01 during a load test).
 * Touches no tables, so it needs no migrated schema.
 */
describe('Database disconnect (e2e)', () => {
  let admin: Pool;
  let pool: Pool;
  const logged: Array<{ level: string; code: unknown }> = [];
  const logger = {
    warn: (obj: object) =>
      logged.push({ level: 'warn', code: (obj as { err?: { code?: string } }).err?.code }),
    error: (obj: object) =>
      logged.push({ level: 'error', code: (obj as { err?: { code?: string } }).err?.code }),
  };
  const terminate = async (pid: number) => {
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    // Let the FATAL message reach the client socket.
    await new Promise((resolve) => setTimeout(resolve, 300));
  };

  beforeAll(() => {
    admin = new Pool({ connectionString: DB_URL, max: 1 });
    pool = createPool({ connectionString: DB_URL, max: 2, applicationName: APP }, logger);
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  beforeEach(() => {
    logged.length = 0;
  });

  it('fails the transaction whose connection was killed between statements and keeps serving', async () => {
    const db = drizzle(pool);
    await expect(
      db.transaction(async (tx) => {
        const { rows } = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        await terminate(rows[0]!.pid);
        await tx.execute(sql`SELECT 1`);
      }),
    ).rejects.toThrow();

    expect(logged).toContainEqual({ level: 'warn', code: '57P01' });
    const { rows } = await db.execute<{ ok: number }>(sql`SELECT 1 AS ok`);
    expect(rows[0]!.ok).toBe(1);
  });

  it('survives a killed checked-out client that is released afterwards', async () => {
    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await terminate(rows[0]!.pid);
    await expect(client.query('SELECT 1')).rejects.toThrow();
    client.release();

    // The pool discarded the broken client and opens a new connection.
    const again = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(again.rows[0]!.ok).toBe(1);
    expect(logged.map((l) => l.code)).toContain('57P01');
  });

  it('still logs a dropped idle connection through the pool listener', async () => {
    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    client.release();
    await terminate(rows[0]!.pid);

    const again = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(again.rows[0]!.ok).toBe(1);
    expect(logged.map((l) => l.code)).toContain('57P01');
  });
});
