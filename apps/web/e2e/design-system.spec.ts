import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { login } from './helpers';

/**
 * Executive Finance design system: theme switching, shell behaviour,
 * keyboard access, reduced motion and responsive layout.
 */
test.describe('design system', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  /** The shell (and its shortcut listeners) mounts once the session has loaded. */
  const ready = async (page: Page) => {
    await expect(page.getByTestId('global-search')).toBeVisible();
  };

  test('dark theme is the default and light mode persists across reloads', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.getByTestId('theme-toggle').click();
    await page.getByTestId('theme-light').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem('accounting.theme'))).toBe('light');

    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    // The pre-hydration script must apply the class before React mounts.
    const bg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor.replace(/\s/g, ''),
    );
    expect(bg).toBe('rgb(247,248,250)');

    await page.getByTestId('theme-toggle').click();
    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('sidebar collapses with the control and with Ctrl+B, and remembers it', async ({ page }) => {
    await page.goto('/dashboard');
    await ready(page);
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).not.toHaveAttribute('data-collapsed');
    await page.getByTestId('sidebar-toggle').click();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    await page.reload();
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');
    await page.keyboard.press('Control+b');
    await expect(page.getByTestId('sidebar')).not.toHaveAttribute('data-collapsed');
    // Collapsed sections open their items in a menu.
    await page.getByTestId('sidebar-toggle').click();
    await page.getByRole('button', { name: 'Accounting' }).click();
    await expect(page.getByRole('menuitem', { name: /Journal Entries/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('sidebar-toggle').click();
  });

  test('command palette opens with Ctrl+K, searches records and navigates by keyboard', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await ready(page);
    await page.keyboard.press('Control+k');
    const input = page.getByTestId('command-input');
    await expect(input).toBeFocused();
    await input.fill('trial balance');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/accounting\/trial-balance/);

    await page.keyboard.press('Control+/');
    await page.getByTestId('command-input').fill('JE-2026');
    await expect(page.getByRole('option', { name: /JE-2026-\d{6}/ }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-input')).toHaveCount(0);
  });

  test('keyboard shortcuts dialog and go-to chords', async ({ page }) => {
    await page.goto('/dashboard');
    await ready(page);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('g');
    await page.keyboard.press('j');
    await expect(page).toHaveURL(/\/accounting\/journal-entries/);
  });

  test('focus is visible on interactive controls', async ({ page }) => {
    await page.goto('/dashboard');
    await ready(page);
    await page.keyboard.press('Tab');
    const active = page.locator(':focus-visible');
    await expect(active).toHaveCount(1);
    const outline = await active.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });

  test('reduced motion removes non-essential animation but keeps state visible', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      reducedMotion: 'reduce',
      storageState: 'e2e/.auth/admin.json',
    });
    const page = await context.newPage();
    await page.goto('/dashboard');
    await expect(page.getByTestId('financial-health')).toBeVisible();
    const durations = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return [
        s.getPropertyValue('--motion-normal').trim(),
        s.getPropertyValue('--motion-data').trim(),
      ];
    });
    // The production CSS minifier writes 0ms as 0s; both mean no motion.
    expect(durations.map((d) => d.replace(/^0m?s$/, '0'))).toEqual(['0', '0']);
    await context.close();
  });

  test('status badges carry an icon and text, never colour alone', async ({ page }) => {
    await page.goto('/accounting/journal-entries');
    const badge = page.locator('[data-tone]').first();
    await expect(badge).toBeVisible();
    await expect(badge.locator('svg, .rounded-full')).toHaveCount(1);
    await expect(badge).not.toHaveText('');
  });

  test('mobile layout hides the sidebar behind the menu button', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard');
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  });
});
