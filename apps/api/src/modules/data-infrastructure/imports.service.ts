import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { ImportType, PaginatedResult } from '@accounting/types';
import type {
  CommitImportInput,
  CreateImportInput,
  CreateJournalEntryInput,
  ListImportsQuery,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accounts,
  bankAccounts,
  customers,
  importJobs,
  productCategories,
  products,
  vendors,
  type ImportJob,
  type ImportRow,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { JournalEntriesService } from '@/modules/accounting/journals/journal-entries.service';
import { AuditService } from '@/modules/audit/audit.service';
import { BankingService } from '@/modules/banking/banking.service';
import { CatalogService } from '@/modules/inventory/catalog.service';
import { VendorsService } from '@/modules/payables/vendors.service';
import { CustomersService } from '@/modules/receivables/customers.service';
import { parseCsv } from './csv';
import { IMPORT_SPECS, type ImportSpec } from './import-specs';

const MODULE = 'DATA_INFRASTRUCTURE';
const MAX_ROWS = 5000;
const MAX_BYTES = 5 * 1024 * 1024;

export interface ImportFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ImportJobView extends Omit<ImportJob, 'rows'> {
  spec: Pick<ImportSpec, 'title' | 'atomic' | 'columns'>;
  createdByEmail: string | null;
}

export interface ImportJobDetail extends ImportJobView {
  rows: ImportRow[];
}

interface Lookups {
  accountsByCode: Map<string, { id: string; isHeader: boolean; status: string }>;
  customerCodes: Set<string>;
  vendorCodes: Set<string>;
  productSkus: Set<string>;
  categoriesByCode: Map<string, string>;
  bankAccountsByCode: Map<string, string>;
}

/**
 * CSV import engine (hardening phase 6). Upload parses and validates the file
 * - cell rules from the spec, referential checks against the company's data,
 * duplicates within the file - and stores the rows with their errors so the
 * preview is exactly what will be committed. Commit creates the records
 * through the owning domain services (never by writing tables directly):
 * financial datasets (journals, opening balances, bank transactions) are
 * all-or-nothing and refuse a file with any invalid row; master data commits
 * row by row, optionally skipping invalid rows, and reports every outcome.
 */
@Injectable()
export class ImportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly journals: JournalEntriesService,
    private readonly customers: CustomersService,
    private readonly vendors: VendorsService,
    private readonly catalog: CatalogService,
    private readonly banking: BankingService,
  ) {}

  // -------------------------------------------------------------------- upload

  async upload(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateImportInput,
    file: ImportFile,
  ): Promise<ImportJobDetail> {
    if (!file)
      throw new BusinessRuleError(ErrorCodes.IMPORT_FILE_INVALID, 'A CSV file is required.');
    if (file.size > MAX_BYTES)
      throw new BusinessRuleError(ErrorCodes.IMPORT_FILE_INVALID, 'The file exceeds 5 MB.');
    if (!/\.csv$/i.test(file.originalname) && !/csv|text\/plain/.test(file.mimetype))
      throw new BusinessRuleError(ErrorCodes.IMPORT_FILE_INVALID, 'Only CSV files are supported.');
    const spec = IMPORT_SPECS[input.type];
    const parsed = parseCsv(file.buffer.toString('utf8'), { maxRows: MAX_ROWS });
    if (parsed.rows.length === 0)
      throw new BusinessRuleError(ErrorCodes.IMPORT_FILE_INVALID, 'The file has no data rows.');
    const missing = spec.columns.filter((c) => c.required && !parsed.headers.includes(c.key));
    if (missing.length > 0)
      throw new BusinessRuleError(
        ErrorCodes.IMPORT_FILE_INVALID,
        `Missing required column(s): ${missing.map((c) => c.key).join(', ')}.`,
        { missing: missing.map((c) => c.key), headers: parsed.headers },
      );
    if (input.type === 'OPENING_BALANCES' && !input.asOfDate)
      throw new BusinessRuleError(
        ErrorCodes.IMPORT_FILE_INVALID,
        'Opening balances need the cut-over date (asOfDate).',
      );

    const lookups = await this.lookups(companyId);
    const rows: ImportRow[] = parsed.rows.map((r) => ({
      line: r.line,
      values: r.values,
      errors: [],
    }));
    for (const row of rows) {
      const result = spec.row.safeParse(row.values);
      if (!result.success) {
        row.errors.push(
          ...result.error.issues.map((i) =>
            i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
          ),
        );
        continue;
      }
      row.errors.push(...this.referentialErrors(input.type, result.data, lookups));
    }
    this.duplicateErrors(input.type, rows);
    if (input.type === 'JOURNAL_ENTRIES') this.balanceErrors(rows);

    const errorCount = rows.filter((r) => r.errors.length > 0).length;
    const [job] = await this.db
      .insert(importJobs)
      .values({
        companyId,
        type: input.type,
        status: 'VALIDATED',
        fileName: file.originalname,
        options: { asOfDate: input.asOfDate ?? null, branchId: input.branchId ?? null },
        rowCount: rows.length,
        validCount: rows.length - errorCount,
        errorCount,
        rows,
        branchId: input.branchId ?? null,
        createdBy: actor.id,
      })
      .returning();
    return this.get(companyId, job!.id);
  }

  // -------------------------------------------------------------------- commit

  async commit(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: CommitImportInput,
  ): Promise<ImportJobDetail> {
    const job = await this.lockable(companyId, id);
    if (job.status !== 'VALIDATED')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `This import is ${job.status.toLowerCase()} and cannot be committed.`,
      );
    const spec = IMPORT_SPECS[job.type];
    if (job.errorCount > 0 && (spec.atomic || !input.skipInvalid))
      throw new BusinessRuleError(
        ErrorCodes.IMPORT_INVALID_ROWS,
        spec.atomic
          ? `${job.errorCount} row(s) are invalid; a ${spec.title.toLowerCase()} import is all-or-nothing. Fix the file and upload it again.`
          : `${job.errorCount} row(s) are invalid. Fix the file or commit with skipInvalid.`,
        { errorCount: job.errorCount },
      );
    const rows = job.rows.filter((r) => r.errors.length === 0);
    const options = job.options as { asOfDate?: string | null; branchId?: string | null };
    let outcome: { created: number; failed: number; documents: string[]; error?: string };
    try {
      outcome = spec.atomic
        ? await this.commitAtomic(companyId, actor, job.type, rows, options)
        : await this.commitRows(companyId, actor, job.type, rows);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(importJobs)
        .set({ status: 'FAILED', result: { error: message }, rows: job.rows })
        .where(eq(importJobs.id, id));
      await this.audit.record({
        action: 'IMPORT',
        module: MODULE,
        entityType: 'ImportJob',
        entityId: id,
        newValue: { type: job.type, status: 'FAILED', error: message },
        companyId,
      });
      throw err;
    }
    const status = outcome.created === 0 && outcome.failed > 0 ? 'FAILED' : 'COMMITTED';
    await this.db
      .update(importJobs)
      .set({
        status,
        result: outcome,
        rows: job.rows,
        committedBy: actor.id,
        committedAt: new Date(),
      })
      .where(eq(importJobs.id, id));
    await this.audit.record({
      action: 'IMPORT',
      module: MODULE,
      entityType: 'ImportJob',
      entityId: id,
      newValue: {
        type: job.type,
        fileName: job.fileName,
        status,
        created: outcome.created,
        failed: outcome.failed,
        skipped: job.errorCount,
      },
      metadata: { actor: actor.email },
      companyId,
    });
    return this.get(companyId, id);
  }

  async cancel(companyId: string, actor: AuthenticatedUser, id: string): Promise<ImportJobDetail> {
    const job = await this.lockable(companyId, id);
    if (job.status !== 'VALIDATED')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `This import is ${job.status.toLowerCase()}.`,
      );
    await this.db
      .update(importJobs)
      .set({ status: 'CANCELLED', committedBy: actor.id, committedAt: new Date() })
      .where(eq(importJobs.id, id));
    return this.get(companyId, id);
  }

  // --------------------------------------------------------------------- reads

  async list(companyId: string, query: ListImportsQuery): Promise<PaginatedResult<ImportJobView>> {
    const filters: SQL[] = [eq(importJobs.companyId, companyId)];
    if (query.type) filters.push(eq(importJobs.type, query.type));
    if (query.status) filters.push(eq(importJobs.status, query.status));
    const where = and(...filters);
    const [items, total] = await Promise.all([
      this.db
        .select()
        .from(importJobs)
        .where(where)
        .orderBy(desc(importJobs.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, importJobs, where),
    ]);
    return toPaginatedResult(
      items.map((j) => this.view(j)),
      total,
      query,
    );
  }

  async get(companyId: string, id: string): Promise<ImportJobDetail> {
    const job = await this.lockable(companyId, id);
    return { ...this.view(job), rows: job.rows };
  }

  // ------------------------------------------------------------- validation

  private async lookups(companyId: string): Promise<Lookups> {
    const [acc, cust, vend, prod, cats, banks] = await Promise.all([
      this.db
        .select({
          code: accounts.code,
          id: accounts.id,
          isHeader: accounts.isHeader,
          status: accounts.status,
        })
        .from(accounts)
        .where(eq(accounts.companyId, companyId)),
      this.db
        .select({ code: customers.code })
        .from(customers)
        .where(eq(customers.companyId, companyId)),
      this.db.select({ code: vendors.code }).from(vendors).where(eq(vendors.companyId, companyId)),
      this.db.select({ sku: products.sku }).from(products).where(eq(products.companyId, companyId)),
      this.db
        .select({ code: productCategories.code, id: productCategories.id })
        .from(productCategories)
        .where(eq(productCategories.companyId, companyId)),
      this.db
        .select({ code: bankAccounts.code, id: bankAccounts.id })
        .from(bankAccounts)
        .where(eq(bankAccounts.companyId, companyId)),
    ]);
    return {
      accountsByCode: new Map(acc.map((a) => [a.code, a])),
      customerCodes: new Set(cust.map((c) => c.code)),
      vendorCodes: new Set(vend.map((v) => v.code)),
      productSkus: new Set(prod.map((p) => p.sku)),
      categoriesByCode: new Map(cats.map((c) => [c.code, c.id])),
      bankAccountsByCode: new Map(banks.map((b) => [b.code, b.id])),
    };
  }

  private referentialErrors(
    type: ImportType,
    row: Record<string, unknown>,
    lookups: Lookups,
  ): string[] {
    const errors: string[] = [];
    const postable = (key: string) => {
      const value = row[key] as string | undefined;
      if (!value) return;
      const account = lookups.accountsByCode.get(value);
      if (!account) errors.push(`${key}: unknown account ${value}`);
      else if (account.isHeader) errors.push(`${key}: ${value} is a header account`);
      else if (account.status !== 'ACTIVE') errors.push(`${key}: ${value} is inactive`);
    };
    switch (type) {
      case 'CHART_OF_ACCOUNTS':
        if (lookups.accountsByCode.has(row.code as string))
          errors.push(`code: account ${row.code as string} already exists`);
        break;
      case 'CUSTOMERS':
        if (lookups.customerCodes.has(row.code as string))
          errors.push(`code: customer ${row.code as string} already exists`);
        break;
      case 'VENDORS':
        if (lookups.vendorCodes.has(row.code as string))
          errors.push(`code: vendor ${row.code as string} already exists`);
        break;
      case 'PRODUCTS':
        if (lookups.productSkus.has(row.sku as string))
          errors.push(`sku: product ${row.sku as string} already exists`);
        if (row.category_code && !lookups.categoriesByCode.has(row.category_code as string))
          errors.push(`category_code: unknown category ${row.category_code as string}`);
        break;
      case 'OPENING_BALANCES':
      case 'JOURNAL_ENTRIES':
        postable('account_code');
        break;
      case 'BANK_TRANSACTIONS':
        if (!lookups.bankAccountsByCode.has(row.bank_account_code as string))
          errors.push(`bank_account_code: unknown bank account ${row.bank_account_code as string}`);
        if (
          row.to_bank_account_code &&
          !lookups.bankAccountsByCode.has(row.to_bank_account_code as string)
        )
          errors.push(
            `to_bank_account_code: unknown bank account ${row.to_bank_account_code as string}`,
          );
        postable('counterparty_account_code');
        break;
    }
    return errors;
  }

  /** The same code twice in one file is an error on the later row. */
  private duplicateErrors(type: ImportType, rows: ImportRow[]): void {
    const key = { CHART_OF_ACCOUNTS: 'code', CUSTOMERS: 'code', VENDORS: 'code', PRODUCTS: 'sku' }[
      type as string
    ];
    if (!key) return;
    const seen = new Map<string, number>();
    for (const row of rows) {
      const value = row.values[key];
      if (!value) continue;
      const first = seen.get(value);
      if (first !== undefined) row.errors.push(`${key}: duplicate of line ${first}`);
      else seen.set(value, row.line);
    }
  }

  /** Journal groups must balance; an unbalanced group marks every line of it. */
  private balanceErrors(rows: ImportRow[]): void {
    const groups = new Map<string, ImportRow[]>();
    for (const row of rows) {
      const entry = row.values.entry;
      if (!entry) continue;
      groups.set(entry, [...(groups.get(entry) ?? []), row]);
    }
    for (const [entry, lines] of groups) {
      if (lines.some((l) => l.errors.length > 0)) continue;
      let debit = 0;
      let credit = 0;
      for (const l of lines) {
        debit += Number(l.values.debit || 0);
        credit += Number(l.values.credit || 0);
      }
      if (Math.abs(debit - credit) > 0.00001)
        for (const l of lines)
          l.errors.push(`entry ${entry} does not balance (debit ${debit}, credit ${credit})`);
      if (lines.length < 2)
        for (const l of lines) l.errors.push(`entry ${entry} needs at least two lines`);
    }
  }

  // ----------------------------------------------------------------- commits

  /** Master data: one record per row through the owning service; every outcome is recorded on the row. */
  private async commitRows(
    companyId: string,
    actor: AuthenticatedUser,
    type: ImportType,
    rows: ImportRow[],
  ): Promise<{ created: number; failed: number; documents: string[] }> {
    const lookups = await this.lookups(companyId);
    let created = 0;
    let failed = 0;
    const documents: string[] = [];
    const ordered = type === 'CHART_OF_ACCOUNTS' ? orderParentsFirst(rows) : rows;
    for (const row of ordered) {
      const data = IMPORT_SPECS[type].row.parse(row.values);
      try {
        const result = await this.createOne(companyId, actor, type, data, lookups);
        row.result = result;
        created += 1;
        documents.push(result);
      } catch (err) {
        row.errors.push(err instanceof Error ? err.message : String(err));
        failed += 1;
      }
    }
    return { created, failed, documents };
  }

  private async createOne(
    companyId: string,
    actor: AuthenticatedUser,
    type: ImportType,
    r: Record<string, unknown>,
    lookups: Lookups,
  ): Promise<string> {
    const s = (k: string) => r[k] as string | undefined;
    switch (type) {
      case 'CHART_OF_ACCOUNTS': {
        const parentCode = s('parent_code');
        let parentId: string | null = null;
        if (parentCode) {
          const parent = lookups.accountsByCode.get(parentCode);
          if (!parent) throw new Error(`parent_code: unknown account ${parentCode}`);
          parentId = parent.id;
        }
        const account = await this.accounts.create(companyId, {
          code: s('code')!,
          name: s('name')!,
          type: r.type as never,
          subtype: (r.subtype as never) ?? null,
          parentId,
          isHeader: Boolean(r.is_header),
          description: s('description'),
          isReconciliation: false,
          allowedBranchIds: [],
        } as never);
        lookups.accountsByCode.set(account.code, {
          id: account.id,
          isHeader: account.isHeader,
          status: account.status,
        });
        return account.code;
      }
      case 'CUSTOMERS': {
        const c = await this.customers.create(companyId, {
          code: s('code')!,
          name: s('name')!,
          legalName: s('legal_name'),
          taxIdentificationNumber: s('tax_id'),
          email: s('email'),
          phone: s('phone'),
          contactPerson: s('contact_person'),
          paymentTermsDays: (r.payment_terms_days as number | undefined) ?? 30,
          creditLimit: s('credit_limit') ?? null,
          currency: s('currency'),
          addressLine1: s('address_line1'),
          city: s('city'),
          country: s('country') ?? 'PH',
        } as never);
        return c.code;
      }
      case 'VENDORS': {
        const v = await this.vendors.create(companyId, {
          code: s('code')!,
          name: s('name')!,
          legalName: s('legal_name'),
          taxIdentificationNumber: s('tax_id'),
          email: s('email'),
          phone: s('phone'),
          contactPerson: s('contact_person'),
          paymentTermsDays: (r.payment_terms_days as number | undefined) ?? 30,
          currency: s('currency'),
          addressLine1: s('address_line1'),
          city: s('city'),
          country: s('country') ?? 'PH',
        } as never);
        return v.code;
      }
      case 'PRODUCTS': {
        const p = await this.catalog.createProduct(companyId, actor, {
          sku: s('sku')!,
          name: s('name')!,
          description: s('description'),
          categoryId: s('category_code') ? lookups.categoriesByCode.get(s('category_code')!) : null,
          productType: (r.product_type as never) ?? 'GOODS',
          trackingMode: (r.tracking_mode as never) ?? 'NONE',
          costingMethod: (r.costing_method as never) ?? null,
          unitOfMeasure: s('unit_of_measure') ?? 'pc',
          barcode: s('barcode'),
          salePrice: s('sale_price') ?? null,
          purchasePrice: s('purchase_price') ?? null,
          standardCost: s('standard_cost') ?? null,
          reorderLevel: s('reorder_level') ?? null,
        } as never);
        return p.sku;
      }
      default:
        throw new Error(`${type} is not a row-by-row import`);
    }
  }

  /** Financial datasets: all rows or nothing. */
  private async commitAtomic(
    companyId: string,
    actor: AuthenticatedUser,
    type: ImportType,
    rows: ImportRow[],
    options: { asOfDate?: string | null; branchId?: string | null },
  ): Promise<{ created: number; failed: number; documents: string[] }> {
    const lookups = await this.lookups(companyId);
    const data = rows.map((r) => ({ row: r, data: IMPORT_SPECS[type].row.parse(r.values) }));
    const accountId = (code: string) => lookups.accountsByCode.get(code)!.id;
    switch (type) {
      case 'OPENING_BALANCES': {
        const detail = await this.journals.openingBalances(companyId, actor, {
          asOfDate: options.asOfDate!,
          description: 'Opening balances (import)',
          branchId: options.branchId ?? null,
          lines: data.map(({ data: d }) => ({
            accountId: accountId(d.account_code as string),
            debit: (d.debit as string | undefined) ?? '0',
            credit: (d.credit as string | undefined) ?? '0',
            description: (d.description as string | undefined) ?? undefined,
            branchId: options.branchId ?? null,
            departmentId: null,
            costCenterId: null,
            projectId: null,
          })),
        });
        for (const { row } of data) row.result = detail.documentNumber;
        return { created: 1, failed: 0, documents: [detail.documentNumber] };
      }
      case 'JOURNAL_ENTRIES': {
        const groups = new Map<string, typeof data>();
        for (const item of data) {
          const key = item.data.entry as string;
          groups.set(key, [...(groups.get(key) ?? []), item]);
        }
        const numbers = await this.db.transaction(async (tx) => {
          const out: string[] = [];
          for (const [, lines] of groups) {
            const head = lines[0]!.data;
            const input: CreateJournalEntryInput = {
              entryDate: head.date as string,
              description: head.description as string,
              reference: (head.reference as string | undefined) ?? undefined,
              journalType: 'GENERAL',
              branchId: options.branchId ?? null,
              lines: lines.map(({ data: d }) => ({
                accountId: accountId(d.account_code as string),
                debit: (d.debit as string | undefined) ?? '0',
                credit: (d.credit as string | undefined) ?? '0',
                description: (d.line_description as string | undefined) ?? undefined,
                branchId: options.branchId ?? null,
                departmentId: null,
                costCenterId: null,
                projectId: null,
              })),
            } as CreateJournalEntryInput;
            const id = await this.journals.createIn(tx, companyId, actor, input);
            const number = await this.journals.documentNumberOf(tx, id);
            for (const { row } of lines) row.result = number;
            out.push(number);
          }
          return out;
        });
        return { created: numbers.length, failed: 0, documents: numbers };
      }
      case 'BANK_TRANSACTIONS': {
        // Drafts only (no ledger effect); one transaction per row, refusing the file when any row fails
        // would leave earlier drafts, so every row was fully validated before this point.
        const documents: string[] = [];
        for (const { row, data: d } of data) {
          const view = await this.banking.createTransaction(companyId, actor, {
            bankAccountId: lookups.bankAccountsByCode.get(d.bank_account_code as string)!,
            transactionType: d.type as never,
            transactionDate: d.date as string,
            amount: d.amount as string,
            counterpartyAccountId: d.counterparty_account_code
              ? accountId(d.counterparty_account_code as string)
              : undefined,
            toBankAccountId: d.to_bank_account_code
              ? lookups.bankAccountsByCode.get(d.to_bank_account_code as string)
              : undefined,
            reference: (d.reference as string | undefined) ?? undefined,
            memo: (d.memo as string | undefined) ?? undefined,
          });
          row.result = view.documentNumber;
          documents.push(view.documentNumber);
        }
        return { created: documents.length, failed: 0, documents };
      }
      default:
        throw new Error(`${type} is not an atomic import`);
    }
  }

  // ----------------------------------------------------------------- helpers

  private async lockable(companyId: string, id: string): Promise<ImportJob> {
    const [job] = await this.db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.id, id), eq(importJobs.companyId, companyId)));
    if (!job) throw new NotFoundError('Import', id);
    return job;
  }

  private view(job: ImportJob): ImportJobView {
    const { rows: _rows, ...rest } = job;
    const spec = IMPORT_SPECS[job.type];
    return {
      ...rest,
      spec: { title: spec.title, atomic: spec.atomic, columns: spec.columns },
      createdByEmail: null,
    };
  }
}

/** Header accounts before their children so a parent referenced by code exists when the child is created. */
function orderParentsFirst(rows: ImportRow[]): ImportRow[] {
  const byCode = new Map(rows.map((r) => [r.values.code, r]));
  const depth = (row: ImportRow, seen = new Set<string>()): number => {
    const parent = row.values.parent_code;
    if (!parent || !byCode.has(parent) || seen.has(parent)) return 0;
    seen.add(parent);
    return 1 + depth(byCode.get(parent)!, seen);
  };
  return [...rows].sort((a, b) => depth(a) - depth(b) || a.line - b.line);
}
