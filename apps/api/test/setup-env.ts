/* Loaded by jest before the e2e suite: points the app at the test database. */
import '../src/config/load-env';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://accounting:accounting@localhost:5433/accounting_test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.STORAGE_DIR = process.env.TEST_STORAGE_DIR ?? './storage-test';
process.env.AI_PROVIDER = 'HEURISTIC';
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? 'test-secret-test-secret-test-secret-1234';

// Safety net: e2e suites DROP and recreate the schema, so they may only ever
// point at a database whose name marks it as disposable.
const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
if (!/test/i.test(dbName)) {
  throw new Error(`Refusing to run e2e tests against non-test database "${dbName}"`);
}
