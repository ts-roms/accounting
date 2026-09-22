import { Injectable } from '@nestjs/common';
import { P, type ExportDataset, type PermissionKey } from '@accounting/types';
import type { ExportQuery } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { JournalEntriesService } from '@/modules/accounting/journals/journal-entries.service';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { AuditService } from '@/modules/audit/audit.service';
import { ApReportsService } from '@/modules/payables/ap-reports.service';
import { VendorsService } from '@/modules/payables/vendors.service';
import { ArReportsService } from '@/modules/receivables/ar-reports.service';
import { CustomersService } from '@/modules/receivables/customers.service';
import { ReportingService } from '@/modules/reporting/reporting.service';
import { businessToday } from '@/common/time/clock';
import { toCsv, type CsvColumn } from './csv';

export interface ExportFile {
  fileName: string;
  contentType: 'text/csv; charset=utf-8';
  body: string;
  rows: number;
}

/** The view permission each dataset needs on top of `reports.export`. */
export const DATASET_PERMISSION: Record<ExportDataset, PermissionKey> = {
  TRIAL_BALANCE: P['reports.view'],
  GENERAL_LEDGER: P['reports.view'],
  JOURNAL_ENTRIES: P['journal.view'],
  CHART_OF_ACCOUNTS: P['account.view'],
  CUSTOMERS: P['customer.view'],
  VENDORS: P['vendor.view'],
  AR_AGING: P['reports.view'],
  AP_AGING: P['reports.view'],
  AUDIT_LOGS: P['audit.view'],
};

const today = businessToday;
const PAGE = 200;

/**
 * CSV exports of reports and lists (hardening phase 6). Every dataset is read
 * through the service that owns it - the export never re-derives a figure -
 * and every export is audited (who, what, filters, row count).
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly reporting: ReportingService,
    private readonly ledger: GeneralLedgerService,
    private readonly journals: JournalEntriesService,
    private readonly accounts: AccountsService,
    private readonly customers: CustomersService,
    private readonly vendors: VendorsService,
    private readonly ar: ArReportsService,
    private readonly ap: ApReportsService,
    private readonly audit: AuditService,
  ) {}

  async export(
    companyId: string,
    actor: AuthenticatedUser,
    query: ExportQuery,
  ): Promise<ExportFile> {
    const file = await this.build(companyId, actor, query);
    await this.audit.record({
      action: 'EXPORT',
      module: 'REPORTING',
      entityType: 'Export',
      entityId: query.dataset,
      newValue: { dataset: query.dataset, fileName: file.fileName, rows: file.rows },
      metadata: { actor: actor.email, filters: { ...query, dataset: undefined } },
      companyId,
    });
    return file;
  }

  private async build(
    companyId: string,
    actor: AuthenticatedUser,
    q: ExportQuery,
  ): Promise<ExportFile> {
    const stamp = (q.asOf ?? q.to ?? today()).replaceAll('-', '');
    switch (q.dataset) {
      case 'TRIAL_BALANCE': {
        const { from, to } = range(q);
        const report = await this.reporting.trialBalance(companyId, {
          from,
          to,
          includeZero: false,
        });
        return file(`trial-balance-${stamp}.csv`, report.rows, [
          col('Account code', (r) => r.code),
          col('Account name', (r) => r.name),
          col('Type', (r) => r.type),
          col('Opening debit', (r) => r.openingDebit),
          col('Opening credit', (r) => r.openingCredit),
          col('Period debit', (r) => r.periodDebit),
          col('Period credit', (r) => r.periodCredit),
          col('Closing debit', (r) => r.closingDebit),
          col('Closing credit', (r) => r.closingCredit),
        ]);
      }
      case 'GENERAL_LEDGER': {
        if (!q.accountId)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            'accountId is required for a general ledger export.',
          );
        const { from, to } = range(q);
        const lines: Awaited<ReturnType<GeneralLedgerService['ledger']>>['lines'] = [];
        let page = 1;
        let code = '';
        for (;;) {
          const result = await this.ledger.ledger(companyId, {
            accountId: q.accountId,
            from,
            to,
            page,
            pageSize: 500,
          });
          code = result.account.code;
          lines.push(...result.lines);
          if (lines.length >= result.total || result.lines.length === 0) break;
          page += 1;
        }
        return file(`general-ledger-${code}-${stamp}.csv`, lines, [
          col('Date', (r) => r.entryDate),
          col('Journal', (r) => r.documentNumber),
          col('Type', (r) => r.journalType),
          col('Status', (r) => r.status),
          col('Description', (r) => r.lineDescription ?? r.entryDescription),
          col('Reference', (r) => r.reference),
          col('Debit', (r) => r.debit),
          col('Credit', (r) => r.credit),
          col('Balance', (r) => r.balance),
        ]);
      }
      case 'JOURNAL_ENTRIES': {
        const rows = await this.allPages((page) =>
          this.journals.list(companyId, {
            page,
            pageSize: PAGE,
            sortDir: 'asc',
            from: q.from,
            to: q.to,
            status: q.status as never,
            search: q.search,
          }),
        );
        return file(`journal-entries-${stamp}.csv`, rows, [
          col('Number', (r) => r.documentNumber),
          col('Date', (r) => r.entryDate),
          col('Type', (r) => r.journalType),
          col('Status', (r) => r.status),
          col('Period', (r) => r.periodName),
          col('Description', (r) => r.description),
          col('Reference', (r) => r.reference),
          col('Debit', (r) => r.totalDebit),
          col('Credit', (r) => r.totalCredit),
          col('Created by', (r) => r.createdByEmail),
          col('Posted by', (r) => r.postedByEmail),
        ]);
      }
      case 'CHART_OF_ACCOUNTS': {
        const rows = await this.accounts.list(companyId, {});
        return file(`chart-of-accounts-${stamp}.csv`, rows, [
          col('Code', (r) => r.code),
          col('Name', (r) => r.name),
          col('Type', (r) => r.type),
          col('Subtype', (r) => r.subtype),
          col('Normal balance', (r) => r.normalBalance),
          col('Header', (r) => r.isHeader),
          col('Level', (r) => r.level),
          col('Status', (r) => r.status),
        ]);
      }
      case 'CUSTOMERS': {
        const rows = await this.allPages((page) =>
          this.customers.list(companyId, {
            page,
            pageSize: PAGE,
            sortDir: 'asc',
            search: q.search,
          }),
        );
        return file(`customers-${stamp}.csv`, rows, partyColumns());
      }
      case 'VENDORS': {
        const rows = await this.allPages((page) =>
          this.vendors.list(companyId, { page, pageSize: PAGE, sortDir: 'asc', search: q.search }),
        );
        return file(`vendors-${stamp}.csv`, rows, partyColumns());
      }
      case 'AR_AGING':
      case 'AP_AGING': {
        const asOf = q.asOf ?? today();
        const report = await (q.dataset === 'AR_AGING' ? this.ar : this.ap).aging(companyId, {
          asOf,
        });
        const bucketCols = report.buckets.map((b) =>
          col<(typeof report.rows)[number]>(
            b.label,
            (r) => (r.buckets as Record<string, string>)[b.key as string] ?? '0',
          ),
        );
        return file(`${q.dataset === 'AR_AGING' ? 'ar' : 'ap'}-aging-${stamp}.csv`, report.rows, [
          col('Code', (r) => r.code),
          col('Name', (r) => r.name),
          ...bucketCols,
          col('Outstanding', (r) => r.outstanding),
          col('Unapplied credit', (r) => r.unappliedCredit),
          col('Net', (r) => r.net),
          col('Oldest due date', (r) => r.oldestDueDate),
          col('Documents', (r) => r.documents),
        ]);
      }
      case 'AUDIT_LOGS': {
        const rows = await this.allPages((page) =>
          this.audit.list(actor.organizationId, {
            page,
            pageSize: PAGE,
            sortDir: 'desc',
            companyId,
            from: q.from,
            to: q.to,
            search: q.search,
          }),
        );
        return file(`audit-logs-${stamp}.csv`, rows, [
          col('Occurred at', (r) => r.occurredAt.toISOString()),
          col('User', (r) => r.userEmail),
          col('Action', (r) => r.action),
          col('Module', (r) => r.module),
          col('Entity type', (r) => r.entityType),
          col('Entity id', (r) => r.entityId),
          col('Previous value', (r) => json(r.previousValue)),
          col('New value', (r) => json(r.newValue)),
          col('IP address', (r) => r.ipAddress),
          col('Correlation id', (r) => r.correlationId),
        ]);
      }
    }
  }

  /** Drains a paginated list (capped at 50 pages so a runaway export cannot exhaust memory). */
  private async allPages<T>(
    fetch: (page: number) => Promise<{ items: T[]; totalPages: number }>,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const result = await fetch(page);
      out.push(...result.items);
      if (page >= result.totalPages) break;
    }
    return out;
  }
}

function range(q: ExportQuery): { from: string; to: string } {
  const to = q.to ?? q.asOf ?? today();
  const from = q.from ?? `${to.slice(0, 4)}-01-01`;
  return { from, to };
}

function col<T>(header: string, value: CsvColumn<T>['value']): CsvColumn<T> {
  return { header, value };
}

function file<T>(
  fileName: string,
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
): ExportFile {
  return {
    fileName,
    contentType: 'text/csv; charset=utf-8',
    body: toCsv(rows, columns),
    rows: rows.length,
  };
}

function json(value: unknown): string {
  return value === null || value === undefined ? '' : JSON.stringify(value);
}

function partyColumns<
  T extends {
    code: string;
    name: string;
    email: string | null;
    paymentTermsDays: number;
    status: string;
    balance: { outstanding: string; overdue: string; unappliedCredit: string; net: string };
  },
>(): CsvColumn<T>[] {
  return [
    col('Code', (r) => r.code),
    col('Name', (r) => r.name),
    col('Email', (r) => r.email),
    col('Payment terms (days)', (r) => r.paymentTermsDays),
    col('Status', (r) => r.status),
    col('Outstanding', (r) => r.balance.outstanding),
    col('Overdue', (r) => r.balance.overdue),
    col('Unapplied credit', (r) => r.balance.unappliedCredit),
    col('Net', (r) => r.balance.net),
  ];
}
