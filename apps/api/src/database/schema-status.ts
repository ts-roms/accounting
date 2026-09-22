import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { DbExecutor } from './database.types';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export interface SchemaStatus {
  /** Migrations bundled with this build. */
  known: number;
  /** Rows in drizzle's migrations table. */
  applied: number;
  /** Bundled migrations newer than the last applied one (empty = schema is current). */
  pending: string[];
}

let journalCache: JournalEntry[] | null = null;

async function journal(): Promise<JournalEntry[]> {
  if (journalCache) return journalCache;
  const file = path.join(__dirname, 'migrations', 'meta', '_journal.json');
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { entries: JournalEntry[] };
  journalCache = parsed.entries;
  return parsed.entries;
}

/**
 * Compares the migration journal shipped with this build to what the database
 * has applied. Readiness (`/health/ready`), the operations console and the job
 * registry all read this: an API running against a database that is behind
 * must say so once, clearly, instead of failing query by query.
 */
export async function schemaStatus(db: DbExecutor): Promise<SchemaStatus> {
  const entries = await journal();
  const result = await db.execute(
    sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC`,
  );
  const applied = (result.rows as unknown as Array<{ created_at: string | number }>).map((r) =>
    Number(r.created_at),
  );
  const last = applied[0] ?? 0;
  return {
    known: entries.length,
    applied: applied.length,
    pending: entries.filter((e) => e.when > last).map((e) => e.tag),
  };
}

/** One-line operator message for a database that is behind the build. */
export function schemaBehindMessage(status: SchemaStatus): string {
  const shown = status.pending.slice(0, 3).join(', ');
  const more = status.pending.length > 3 ? ` +${status.pending.length - 3}` : '';
  return `Database schema is ${status.pending.length} migration(s) behind this build (${shown}${more}); run \`pnpm db:migrate\`.`;
}
