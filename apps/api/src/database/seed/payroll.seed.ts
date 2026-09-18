import { and, eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { PayBracket, PayItemCalculation, PayItemType } from '@accounting/types';
import { buildPayslip, type AppliedItem, type PayItemDef } from '@/modules/payroll/payroll.logic';
import * as schema from '../schema';
import type { Tx } from './seed';
import { allocateNumber, insertEntry } from './seed-ledger';

type Log = (message: string) => void;

/**
 * Payroll demo (Prompt #11) for ACME: statutory-style pay items, five
 * monthly employees across three departments, May - July pay runs posted
 * and paid from the main bank account, August approved and awaiting
 * posting. Dated May onwards only (the accounting e2e suite pins the
 * January - April income statement) and nothing touches the tax register.
 */
export async function seedPayroll(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  if (company.code !== 'ACME') return;
  const [existing] = await tx
    .select({ id: schema.payItems.id })
    .from(schema.payItems)
    .where(eq(schema.payItems.companyId, company.id));
  if (existing) return;

  const currency = company.baseCurrency;
  const now = new Date();
  const salaryExpense = codeToId.get('6100')!;
  const employerExpense = codeToId.get('6110')!;
  const statutoryPayable = codeToId.get('2175')!;
  const withholdingPayable = codeToId.get('2140')!;
  const employeePayable = codeToId.get('2170')!;
  const bank = codeToId.get('1130')!;

  // ---------------------------------------------------------------- pay items
  const WTAX_BRACKETS: PayBracket[] = [
    { over: '0', base: '0', rate: '0' },
    { over: '20833', base: '0', rate: '15' },
    { over: '33333', base: '1875', rate: '20' },
    { over: '66667', base: '8541.80', rate: '25' },
    { over: '166667', base: '33541.80', rate: '30' },
    { over: '666667', base: '183541.80', rate: '35' },
  ];
  const ITEMS: Array<{
    code: string;
    name: string;
    type: PayItemType;
    calculation: PayItemCalculation;
    amount?: string;
    rate?: string;
    maxBase?: string;
    brackets?: PayBracket[];
    taxable?: boolean;
    appliesToAll?: boolean;
    sortOrder: number;
  }> = [
    {
      code: 'BASIC',
      name: 'Basic salary',
      type: 'EARNING',
      calculation: 'BASE_SALARY',
      appliesToAll: true,
      sortOrder: 1,
    },
    { code: 'OT', name: 'Overtime', type: 'EARNING', calculation: 'FIXED', sortOrder: 5 },
    {
      code: 'ALLOW-TRANSPO',
      name: 'Transportation allowance',
      type: 'EARNING',
      calculation: 'FIXED',
      amount: '2000',
      taxable: false,
      appliesToAll: true,
      sortOrder: 10,
    },
    {
      code: 'SSS-EE',
      name: 'SSS contribution (employee)',
      type: 'DEDUCTION',
      calculation: 'PERCENT_OF_GROSS',
      rate: '4.5',
      maxBase: '30000',
      appliesToAll: true,
      sortOrder: 20,
    },
    {
      code: 'PHIC-EE',
      name: 'PhilHealth contribution (employee)',
      type: 'DEDUCTION',
      calculation: 'PERCENT_OF_GROSS',
      rate: '2.5',
      maxBase: '100000',
      appliesToAll: true,
      sortOrder: 21,
    },
    {
      code: 'HDMF-EE',
      name: 'Pag-IBIG contribution (employee)',
      type: 'DEDUCTION',
      calculation: 'FIXED',
      amount: '200',
      appliesToAll: true,
      sortOrder: 22,
    },
    {
      code: 'LOAN',
      name: 'Salary loan repayment',
      type: 'DEDUCTION',
      calculation: 'FIXED',
      sortOrder: 30,
    },
    {
      code: 'SSS-ER',
      name: 'SSS contribution (employer)',
      type: 'EMPLOYER_CONTRIBUTION',
      calculation: 'PERCENT_OF_GROSS',
      rate: '9.5',
      maxBase: '30000',
      appliesToAll: true,
      sortOrder: 40,
    },
    {
      code: 'PHIC-ER',
      name: 'PhilHealth contribution (employer)',
      type: 'EMPLOYER_CONTRIBUTION',
      calculation: 'PERCENT_OF_GROSS',
      rate: '2.5',
      maxBase: '100000',
      appliesToAll: true,
      sortOrder: 41,
    },
    {
      code: 'HDMF-ER',
      name: 'Pag-IBIG contribution (employer)',
      type: 'EMPLOYER_CONTRIBUTION',
      calculation: 'FIXED',
      amount: '200',
      appliesToAll: true,
      sortOrder: 42,
    },
    {
      code: 'WTAX',
      name: 'Withholding tax',
      type: 'WITHHOLDING_TAX',
      calculation: 'BRACKET',
      brackets: WTAX_BRACKETS,
      appliesToAll: true,
      sortOrder: 50,
    },
  ];
  const items = new Map<string, PayItemDef & { dbId: string }>();
  for (const i of ITEMS) {
    const [row] = await tx
      .insert(schema.payItems)
      .values({
        companyId: company.id,
        code: i.code,
        name: i.name,
        type: i.type,
        calculation: i.calculation,
        amount: i.amount ?? null,
        rate: i.rate ?? null,
        maxBase: i.maxBase ?? null,
        brackets: i.brackets ?? [],
        taxable: i.type === 'EARNING' ? (i.taxable ?? true) : false,
        appliesToAll: i.appliesToAll ?? false,
        sortOrder: i.sortOrder,
      })
      .returning({ id: schema.payItems.id });
    items.set(i.code, {
      id: row!.id,
      dbId: row!.id,
      code: i.code,
      name: i.name,
      type: i.type,
      calculation: i.calculation,
      amount: i.amount ?? null,
      rate: i.rate ?? null,
      maxBase: i.maxBase ?? null,
      brackets: i.brackets ?? [],
      taxable: i.type === 'EARNING' ? (i.taxable ?? true) : false,
      sortOrder: i.sortOrder,
    });
  }
  const bankAccountRow = await tx
    .select({ id: schema.bankAccounts.id })
    .from(schema.bankAccounts)
    .where(
      and(eq(schema.bankAccounts.companyId, company.id), eq(schema.bankAccounts.code, 'BDO-MAIN')),
    );
  const payrollBankAccountId = bankAccountRow[0]?.id ?? null;
  await tx
    .insert(schema.payrollSettings)
    .values({
      companyId: company.id,
      payrollBankAccountId,
      reimburseExpenseClaims: true,
      payDateReminderDays: 3,
    })
    .onConflictDoNothing();

  // ---------------------------------------------------------------- employees
  const dept = async (code: string) => {
    const [d] = await tx
      .select({ id: schema.dimensions.id })
      .from(schema.dimensions)
      .where(and(eq(schema.dimensions.companyId, company.id), eq(schema.dimensions.code, code)));
    return d?.id ?? null;
  };
  const [accountant] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.organizationId, company.organizationId),
        eq(schema.users.email, 'accountant@acme.local'),
      ),
    );
  const STAFF = [
    {
      first: 'Maria',
      last: 'Santos',
      title: 'Finance Manager',
      dept: 'ADMIN',
      salary: '60000',
      hired: '2024-02-01',
      userId: accountant?.id ?? null,
      tin: '123-456-789-000',
    },
    {
      first: 'Jose',
      last: 'Reyes',
      title: 'Sales Lead',
      dept: 'SALES',
      salary: '45000',
      hired: '2024-06-15',
      userId: null,
      tin: '234-567-890-000',
    },
    {
      first: 'Ana',
      last: 'Cruz',
      title: 'Operations Supervisor',
      dept: 'OPS',
      salary: '35000',
      hired: '2025-01-10',
      userId: null,
      tin: '345-678-901-000',
      loanFrom: '2026-06-01',
    },
    {
      first: 'Ben',
      last: 'Lim',
      title: 'Warehouse Associate',
      dept: 'OPS',
      salary: '28000',
      hired: '2025-08-01',
      userId: null,
      tin: '456-789-012-000',
    },
    {
      first: 'Carla',
      last: 'Dizon',
      title: 'Sales Associate',
      dept: 'SALES',
      salary: '22000',
      hired: '2026-07-01',
      userId: null,
      tin: '567-890-123-000',
    },
  ];
  const staff: Array<schema.Employee & { loanFrom?: string }> = [];
  for (const s of STAFF) {
    const employeeNumber = await allocateNumber(tx, company.id, 'EMP', s.hired);
    const [row] = await tx
      .insert(schema.employees)
      .values({
        companyId: company.id,
        employeeNumber,
        userId: s.userId,
        firstName: s.first,
        lastName: s.last,
        email: `${s.first.toLowerCase()}.${s.last.toLowerCase()}@acme.local`,
        jobTitle: s.title,
        employmentType: 'FULL_TIME',
        payFrequency: 'MONTHLY',
        baseSalary: s.salary,
        hireDate: s.hired,
        departmentId: await dept(s.dept),
        taxIdentificationNumber: s.tin,
        paymentMethod: 'BANK',
        bankName: 'BDO Unibank',
        bankAccountNumber: `****${String(1000 + staff.length * 111).slice(-4)}`,
        createdBy: adminUserId,
      })
      .returning();
    staff.push({ ...row!, loanFrom: s.loanFrom });
    if (s.loanFrom)
      await tx.insert(schema.employeePayItems).values({
        employeeId: row!.id,
        payItemId: items.get('LOAN')!.dbId,
        amount: '1500',
        effectiveFrom: s.loanFrom,
        effectiveTo: '2026-11-30',
        notes: 'Emergency loan, 6 instalments',
      });
  }

  // Fund the payroll: a second capital contribution so the main bank account keeps its
  // treasury minimum after three months of net pay leave it (nothing else in the seed is touched).
  await insertEntry(
    tx,
    company,
    {
      date: '2026-05-02',
      description: 'Additional capital contribution - working capital for payroll',
      reference: 'CAP-002',
      status: 'POSTED',
      lines: [
        { accountId: bank, debit: '600000', memo: 'Capital contribution' },
        { accountId: codeToId.get('3100')!, credit: '600000', memo: 'Capital contribution' },
      ],
    },
    adminUserId,
  );

  // ----------------------------------------------------------------- pay runs
  const RUNS = [
    {
      start: '2026-05-01',
      end: '2026-05-31',
      pay: '2026-05-31',
      paid: true,
      inputs: [] as Array<{ emp: string; item: string; amount: string; note: string }>,
    },
    {
      start: '2026-06-01',
      end: '2026-06-30',
      pay: '2026-06-30',
      paid: true,
      inputs: [{ emp: 'Lim', item: 'OT', amount: '2500', note: '10 hours inventory count' }],
    },
    { start: '2026-07-01', end: '2026-07-31', pay: '2026-07-31', paid: true, inputs: [] },
    { start: '2026-08-01', end: '2026-08-31', pay: '2026-09-05', paid: false, inputs: [] },
  ];
  const accountFor = (item: PayItemDef): { accountId: string; offsetAccountId: string | null } => {
    switch (item.type) {
      case 'EARNING':
        return { accountId: salaryExpense, offsetAccountId: null };
      case 'DEDUCTION':
        return { accountId: statutoryPayable, offsetAccountId: null };
      case 'WITHHOLDING_TAX':
        return { accountId: withholdingPayable, offsetAccountId: null };
      case 'EMPLOYER_CONTRIBUTION':
        return { accountId: employerExpense, offsetAccountId: statutoryPayable };
    }
  };
  for (const r of RUNS) {
    const documentNumber = await allocateNumber(tx, company.id, 'PYR', r.end);
    const active = staff.filter((e) => e.hireDate <= r.end);
    const [run] = await tx
      .insert(schema.payRuns)
      .values({
        companyId: company.id,
        documentNumber,
        payFrequency: 'MONTHLY',
        periodStart: r.start,
        periodEnd: r.end,
        payDate: r.pay,
        description: 'Monthly payroll',
        status: 'DRAFT',
        currency,
        bankAccountId: payrollBankAccountId,
        createdBy: adminUserId,
      })
      .returning({ id: schema.payRuns.id });
    for (const inp of r.inputs) {
      const e = active.find((x) => x.lastName === inp.emp)!;
      await tx.insert(schema.payRunInputs).values({
        payRunId: run!.id,
        employeeId: e.id,
        payItemId: items.get(inp.item)!.dbId,
        amount: inp.amount,
        note: inp.note,
      });
    }
    const totals = {
      gross: Money.zero(currency),
      taxable: Money.zero(currency),
      withholding: Money.zero(currency),
      deductions: Money.zero(currency),
      employer: Money.zero(currency),
      net: Money.zero(currency),
    };
    const journal = new Map<
      string,
      { accountId: string; departmentId: string | null; debit: Money; credit: Money; memo: string }
    >();
    const book = (
      accountId: string,
      departmentId: string | null,
      side: 'debit' | 'credit',
      amount: string,
      memo: string,
    ) => {
      const key = `${accountId}|${departmentId}|${side}|${memo}`;
      const row = journal.get(key) ?? {
        accountId,
        departmentId,
        debit: Money.zero(currency),
        credit: Money.zero(currency),
        memo,
      };
      if (side === 'debit') row.debit = row.debit.add(Money.of(amount, currency));
      else row.credit = row.credit.add(Money.of(amount, currency));
      journal.set(key, row);
    };
    for (const e of active) {
      const applied: AppliedItem[] = [];
      for (const i of items.values()) {
        if (i.calculation === 'BASE_SALARY') applied.push({ item: i, source: 'BASE' });
        else if (ITEMS.find((x) => x.code === i.code)!.appliesToAll)
          applied.push({ item: i, source: 'COMPANY' });
      }
      if (e.loanFrom && e.loanFrom <= r.end)
        applied.push({
          item: items.get('LOAN')!,
          source: 'ASSIGNMENT',
          amount: '1500',
          note: 'Emergency loan, 6 instalments',
        });
      for (const inp of r.inputs)
        if (active.find((x) => x.lastName === inp.emp)!.id === e.id)
          applied.push({
            item: items.get(inp.item)!,
            source: 'INPUT',
            amount: inp.amount,
            note: inp.note,
          });
      const slip = buildPayslip({ currency, baseSalary: e.baseSalary, applied });
      const [inserted] = await tx
        .insert(schema.payslips)
        .values({
          payRunId: run!.id,
          employeeId: e.id,
          employeeNumber: e.employeeNumber,
          employeeName: `${e.firstName} ${e.lastName}`,
          departmentId: e.departmentId,
          baseSalary: e.baseSalary,
          gross: slip.gross,
          taxable: slip.taxable,
          withholding: slip.withholding,
          deductions: slip.deductions,
          employerContributions: slip.employerContributions,
          reimbursements: slip.reimbursements,
          net: slip.net,
          paymentMethod: e.paymentMethod,
          bankName: e.bankName,
          bankAccountNumber: e.bankAccountNumber,
        })
        .returning({ id: schema.payslips.id });
      await tx.insert(schema.payslipLines).values(
        slip.lines.map((l) => {
          const acct = accountFor(items.get(l.code)!);
          return {
            payslipId: inserted!.id,
            sequence: l.sequence,
            payItemId: items.get(l.code)!.dbId,
            expenseClaimId: null,
            type: l.type,
            code: l.code,
            description: l.description,
            amount: l.amount,
            taxable: l.taxable,
            accountId: acct.accountId,
            offsetAccountId: acct.offsetAccountId,
            source: l.source,
          };
        }),
      );
      for (const l of slip.lines) {
        const acct = accountFor(items.get(l.code)!);
        const memo = `${documentNumber} - ${items.get(l.code)!.name}`;
        if (l.type === 'EARNING') book(acct.accountId, e.departmentId, 'debit', l.amount, memo);
        else if (l.type === 'DEDUCTION' || l.type === 'WITHHOLDING_TAX')
          book(acct.accountId, e.departmentId, 'credit', l.amount, memo);
        else {
          book(acct.accountId, e.departmentId, 'debit', l.amount, memo);
          book(acct.offsetAccountId!, e.departmentId, 'credit', l.amount, memo);
        }
      }
      book(employeePayable, e.departmentId, 'credit', slip.net, `${documentNumber} - net pay`);
      totals.gross = totals.gross.add(Money.of(slip.gross, currency));
      totals.taxable = totals.taxable.add(Money.of(slip.taxable, currency));
      totals.withholding = totals.withholding.add(Money.of(slip.withholding, currency));
      totals.deductions = totals.deductions.add(Money.of(slip.deductions, currency));
      totals.employer = totals.employer.add(Money.of(slip.employerContributions, currency));
      totals.net = totals.net.add(Money.of(slip.net, currency));
    }
    const patch: Partial<schema.PayRun> = {
      status: 'APPROVED',
      employeeCount: active.length,
      grossTotal: totals.gross.toString(),
      taxableTotal: totals.taxable.toString(),
      withholdingTotal: totals.withholding.toString(),
      deductionTotal: totals.deductions.toString(),
      employerTotal: totals.employer.toString(),
      reimbursementTotal: '0',
      netTotal: totals.net.toString(),
      calculatedAt: now,
      submittedAt: now,
      approvedBy: adminUserId,
      approvedAt: now,
    };
    if (r.paid) {
      const entryId = await insertEntry(
        tx,
        company,
        {
          date: r.end,
          description: `Payroll ${documentNumber} - ${r.start} to ${r.end} - Monthly payroll`,
          reference: documentNumber,
          sourceType: 'PAY_RUN',
          sourceId: run!.id,
          status: 'POSTED',
          lines: [...journal.values()].map((l) => ({
            accountId: l.accountId,
            debit: l.debit.toString(),
            credit: l.credit.toString(),
            memo: l.memo,
          })),
        },
        adminUserId,
      );
      const paymentId = await insertEntry(
        tx,
        company,
        {
          date: r.pay,
          description: `Payroll payment ${documentNumber} (${active.length} employee(s))`,
          reference: documentNumber,
          sourceType: 'PAY_RUN_PAYMENT',
          sourceId: run!.id,
          status: 'POSTED',
          lines: [
            {
              accountId: employeePayable,
              debit: totals.net.toString(),
              memo: `${documentNumber} net pay settled`,
            },
            { accountId: bank, credit: totals.net.toString(), memo: `Payroll ${documentNumber}` },
          ],
        },
        adminUserId,
      );
      Object.assign(patch, {
        status: 'PAID',
        journalEntryId: entryId,
        postedBy: adminUserId,
        postedAt: now,
        paymentJournalEntryId: paymentId,
        paymentDate: r.pay,
        paymentReference: documentNumber,
        paidBy: adminUserId,
        paidAt: now,
      });
    }
    await tx.update(schema.payRuns).set(patch).where(eq(schema.payRuns.id, run!.id));
  }
  log(
    `Payroll seeded for ${company.code} (${ITEMS.length} pay items, ${STAFF.length} employees, ${RUNS.length} pay runs)`,
  );
}
