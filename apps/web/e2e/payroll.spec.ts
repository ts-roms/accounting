import { expect, test } from './fixtures';
import { login } from './helpers';

/**
 * Prompt #11 - Payroll section. Runs against the seeded development stack
 * (ACME: eleven pay items, five employees, May - July runs paid, August
 * approved and awaiting posting).
 */
test.describe('payroll', () => {
  test.slow();

  test('pay runs list and detail show the seeded runs, payslips and lifecycle', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/payroll/runs');
    await expect(page.getByRole('heading', { name: 'Pay Runs' })).toBeVisible();
    await expect(page.getByText('PYR-2026-000004')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('PYR-2026-000001')).toBeVisible();
    await page.getByText('PYR-2026-000004').click();
    await expect(page).toHaveURL(/\/payroll\/runs\/[0-9a-f-]+$/);
    await expect(page.getByText('Payslips', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('payslip-row')).toHaveCount(5);
    await expect(page.getByText('Maria Santos')).toBeVisible();
    await expect(page.getByTestId('run-post')).toBeVisible();
    await expect(page.getByText('Lifecycle')).toBeVisible();
    await page.getByTestId('payslip-row').first().click();
    await expect(page).toHaveURL(/\/payroll\/payslips\/[0-9a-f-]+$/);
    await expect(page.getByTestId('payslip-earning')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('payslip-withholding_tax')).toBeVisible();
    await expect(page.getByText('Basic salary')).toBeVisible();
  });

  test('employees list and detail show the seeded staff with recurring items and year-to-date pay', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/payroll/employees');
    await expect(page.getByRole('heading', { name: 'Employees' })).toBeVisible();
    await expect(page.getByText('Ana Cruz')).toBeVisible({ timeout: 45_000 });
    await page.getByText('Ana Cruz').click();
    await expect(page).toHaveURL(/\/payroll\/employees\/[0-9a-f-]+$/);
    await expect(page.getByText('Recurring pay items')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('employee-pay-item')).toHaveCount(1);
    await expect(page.getByText('Salary loan repayment')).toBeVisible();
    await expect(page.getByText('YTD gross', { exact: false })).toBeVisible();
    await expect(page.getByTestId('employee-assign')).toBeVisible();
  });

  test('pay items and payroll reports read from the seed and reconcile', async ({ page }) => {
    await login(page);
    await page.goto('/payroll/pay-items');
    await expect(page.getByRole('heading', { name: 'Pay Items' })).toBeVisible();
    await expect(page.getByTestId('pay-item-row')).toHaveCount(11, { timeout: 45_000 });
    await expect(page.getByText('Progressive brackets')).toBeVisible();
    await expect(page.getByText('Reimburse posted expense claims through pay runs')).toBeVisible();

    await page.goto('/payroll/reports');
    await expect(page.getByRole('heading', { name: 'Payroll Reports' })).toBeVisible();
    await expect(page.getByTestId('payroll-month-row')).toHaveCount(3, { timeout: 45_000 });
    await expect(page.getByTestId('payroll-department-row')).toHaveCount(3);
    await expect(page.getByTestId('withholding-row')).toHaveCount(3);
    await expect(page.getByTestId('payroll-integrity-row')).toHaveCount(4, { timeout: 45_000 });
    await expect(page.getByText('EMPLOYEE_PAYABLE_VS_LEDGER')).toBeVisible();
  });
});
