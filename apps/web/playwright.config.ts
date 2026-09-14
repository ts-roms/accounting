import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests assume the full stack is running locally (API on 3001, web on 3000)
 * with the development seed applied: `pnpm infra:up && pnpm db:migrate && pnpm db:seed && pnpm dev`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // The dev server compiles routes on first hit; give assertions room for that.
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // One worker: the specs share one seeded database and the dev server compiles on first hit.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'setup', testMatch: /auth.setup.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/admin.json' },
      dependencies: ['setup'],
      testIgnore: /auth.setup.ts/,
    },
  ],
});
