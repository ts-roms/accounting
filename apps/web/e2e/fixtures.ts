import { test as base } from '@playwright/test';
import { ADMIN_STATE, isAdminContext } from './helpers';

/**
 * Shared test object for every spec. The automatic fixture persists the
 * context's cookies back to the admin storage state after each test that
 * still holds the admin session, so a refresh-token rotation in one test is
 * carried into the next context instead of tripping the API's reuse detector
 * (which revokes every admin session and sends every later test to /login).
 */
export const test = base.extend<{ persistAdminState: void }>({
  persistAdminState: [
    async ({ context }, use, testInfo) => {
      await use();
      if (testInfo.project.name !== 'chromium' || !isAdminContext(context)) return;
      try {
        await context.storageState({ path: ADMIN_STATE });
      } catch {
        // The context may already be closed when a test failed; the next test simply re-logs in.
      }
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
