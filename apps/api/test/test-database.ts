import fs from 'node:fs';
import path from 'node:path';

/*
 * Which database the e2e suites use. Every suite DROPs and recreates the
 * schema, so two checkouts running e2e at the same time against one database
 * corrupt each other's bootstrap. A git worktree therefore gets its own
 * database automatically (`accounting_test_<worktree>`), and any checkout can
 * pin one with TEST_DATABASE_SUFFIX. `global-setup.ts` creates the database
 * when it does not exist yet.
 */

export const DEFAULT_TEST_DATABASE_URL =
  'postgres://accounting:accounting@127.0.0.1:5433/accounting_test';

/** Monorepo root of this checkout (apps/api/test -> ../../..). */
export function repoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

/** Slug of the worktree directory when this checkout is a git worktree (`.git` is a file), else null. */
export function worktreeSlug(root: string = repoRoot()): string | null {
  try {
    if (!fs.statSync(path.join(root, '.git')).isFile()) return null;
  } catch {
    return null;
  }
  return slugify(path.basename(root));
}

export function slugify(value: string): string | null {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || null;
}

/**
 * The test database URL: TEST_DATABASE_URL (or the default), suffixed with
 * TEST_DATABASE_SUFFIX or the worktree slug so parallel checkouts never share
 * a database. The name always keeps `test` in it (see the safety net in
 * setup-env.ts).
 */
export function resolveTestDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  root: string = repoRoot(),
): string {
  const url = new URL(env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  const suffix = env.TEST_DATABASE_SUFFIX ? slugify(env.TEST_DATABASE_SUFFIX) : worktreeSlug(root);
  if (suffix && !url.pathname.endsWith(`_${suffix}`)) url.pathname = `${url.pathname}_${suffix}`;
  return url.toString();
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}
