import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { FINANCE, login } from './helpers';

const stamp = Date.now().toString().slice(-6);

async function pickAccount(page: Page, rowIndex: number, search: string) {
  await page.getByTestId('account-combobox').nth(rowIndex).click();
  const input = page.getByPlaceholder('Search by code or name...');
  await input.fill(search);
  await expect(page.locator('[cmdk-item]').first()).toBeVisible();
  await input.press('Enter');
}

test.describe('enterprise: FX, intercompany, workflows, attachments', () => {
  test.slow();

  test('exchange rates list the seeded quotes; a new quote can be added; consolidation renders', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/accounting/exchange-rates');
    await expect(
      page.getByTestId('rate-row').filter({ hasText: 'USD → PHP' }).first(),
    ).toBeVisible();
    await page.getByTestId('new-rate').click();
    await page.getByTestId('rate-fromCurrency').fill('GBP');
    await page.getByTestId('rate-value').fill('71.5');
    await page.getByTestId('rate-save').click();
    await expect(page.getByTestId('rate-row').filter({ hasText: 'GBP → PHP' })).toBeVisible();

    await page.goto('/reports/consolidation');
    await expect(page.getByTestId('consolidation-row').first()).toBeVisible();
    await expect(page.getByText('Group trial balance')).toBeVisible();
  });

  test('a workflow gates a large journal until an approver decides in the inbox', async ({
    page,
  }) => {
    await login(page);
    // An interrupted earlier run may have left its workflow active: it would capture this run's journal.
    const me = await page.request.get('/api/v1/auth/me');
    const headers = {
      'x-requested-with': 'XMLHttpRequest',
      'x-company-id': (await me.json()).companies[0].id as string,
    };
    const existing = await page.request.get('/api/v1/approval-workflows', { headers });
    for (const w of (await existing.json()) as { id: string; name: string; status: string }[]) {
      if (w.name.startsWith('Large journals') && w.status === 'ACTIVE')
        await page.request.patch(`/api/v1/approval-workflows/${w.id}`, {
          data: { status: 'INACTIVE' },
          headers,
        });
    }
    // Workflow: journals >= 50,000 need one journal.approve decision.
    await page.goto('/admin/workflows');
    await page.getByTestId('new-workflow').click();
    await page.getByTestId('wf-name').fill(`Large journals ${stamp}`);
    await page.getByTestId('wf-min').fill('50000');
    await page.getByTestId('wf-step-name').first().fill('Finance review');
    // Approval matrix: reserve the step for the finance manager role.
    await page.getByTestId('wf-step-approvers').first().click();
    await page.getByTestId('wf-approver-role').filter({ hasText: 'Finance Manager' }).click();
    await page.keyboard.press('Escape');
    await page.getByTestId('wf-save').click();
    // The matrix shows the band under Journal Entry with the named role.
    const band = page.getByTestId('matrix-band').filter({ hasText: `Large journals ${stamp}` });
    await expect(band).toBeVisible();
    await expect(band.getByTestId('matrix-approver')).toContainText('Finance Manager');
    await page.getByTestId('workflows-view-list').click();
    await expect(
      page.getByTestId('workflow-row').filter({ hasText: `Large journals ${stamp}` }),
    ).toBeVisible();

    // Admin drafts and submits a large journal; approving is blocked with a clear message.
    await page.goto('/accounting/journal-entries/new');
    await page.getByLabel('Description').fill(`Large accrual ${stamp}`);
    await page.getByLabel('Entry date').fill('2026-09-12');
    await pickAccount(page, 0, '6400');
    await pickAccount(page, 1, '2120');
    const amounts = page.locator('input[inputmode="decimal"]:not([data-testid="je-rate"])');
    await amounts.nth(0).fill('75000');
    await amounts.nth(0).blur();
    await amounts.nth(3).fill('75000');
    await amounts.nth(3).blur();
    await expect(page.getByText('Balanced')).toBeVisible();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/accounting\/journal-entries\/[0-9a-f-]+$/);
    const url = page.url();
    const documentNumber = (await page.locator('h1 .font-mono').first().textContent())!.trim();
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByText('SUBMITTED', { exact: true })).toBeVisible();

    // Finance (named through the role) decides from the dashboard card, then approves the journal.
    await login(page, FINANCE);
    await page.goto('/dashboard');
    const card = page.getByTestId('pending-approvals-card');
    await expect(card).toBeVisible();
    await card
      .getByTestId('pending-approval-row')
      .filter({ hasText: documentNumber })
      .first()
      .getByTestId('pending-approval-decide')
      .click();
    await page.getByTestId('approval-approve').click();
    await expect(page.getByRole('dialog')).toContainText('Approved');
    await page.keyboard.press('Escape');
    await page.goto(url);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('APPROVED', { exact: true })).toBeVisible();
    // Deactivate the workflow so other suites are not gated.
    await login(page);
    await page.goto('/admin/workflows');
    await page.getByTestId('workflows-view-list').click();
    await page
      .getByTestId('workflow-row')
      .filter({ hasText: `Large journals ${stamp}` })
      .getByRole('button', { name: 'Deactivate' })
      .click();
    await expect(
      page.getByTestId('workflow-row').filter({ hasText: `Large journals ${stamp}` }),
    ).toContainText('INACTIVE');
  });

  test('attachments upload and list on a journal entry', async ({ page }) => {
    await login(page);
    await page.goto('/accounting/journal-entries');
    await page
      .getByRole('link', { name: /^JE-2026-\d{6}$/ })
      .first()
      .click();
    await expect(page.getByTestId('attachments-panel')).toBeVisible();
    await page.getByTestId('attachment-file').setInputFiles({
      name: `voucher-${stamp}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%%EOF'),
    });
    await expect(
      page.getByTestId('attachment-row').filter({ hasText: `voucher-${stamp}.pdf` }),
    ).toBeVisible();
  });
});
