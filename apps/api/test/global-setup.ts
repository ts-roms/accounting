import { Client } from 'pg';
import '../src/config/load-env';
import { databaseName, resolveTestDatabaseUrl } from './test-database';

/**
 * Jest globalSetup: makes sure the (possibly per-worktree) test database
 * exists before any suite drops and rebuilds its schema. Connects to the
 * server's maintenance database with the same credentials; the docker
 * `accounting` role owns the server, so CREATE DATABASE is allowed.
 */
export default async function ensureTestDatabase(): Promise<void> {
  const url = resolveTestDatabaseUrl();
  const name = databaseName(url);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      // eslint-disable-next-line no-console
      console.log(`[e2e] created test database "${name}"`);
    }
  } finally {
    await client.end();
  }
}
