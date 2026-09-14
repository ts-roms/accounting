/* Development helper: drop the public schema, re-run migrations and seed. */
import '../config/load-env';
import { Pool } from 'pg';
import { runMigrations } from './migrate';
import { runSeed } from './seed/seed';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset is disabled in production');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;',
    );
  } finally {
    await pool.end();
  }
  await runMigrations(url);
  await runSeed(url);
}

main()
  .then(() => {
    console.warn('Database reset complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
