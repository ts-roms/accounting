import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, notInArray, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { PaginatedResult } from '@accounting/types';
import type {
  CreatePaymentFileInput,
  ListPaymentFilesQuery,
  PaymentFileStatusInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  bankAccounts,
  companies,
  paymentFileLines,
  paymentFiles,
  paymentRunLines,
  paymentRuns,
  vendorBankAccounts,
  vendorPayments,
  vendors,
  type PaymentFile,
  type PaymentFileLine,
} from '@/database/schema';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { businessToday } from '@/common/time/clock';
import { TreasuryConfigService } from './treasury-config.service';
import {
  fileTotals,
  renderPain001,
  renderPesonetCsv,
  renderPositivePayCsv,
  sha256,
  type PaymentFileEntry,
} from './treasury.logic';

const MODULE = 'TREASURY';
const LIVE_STATUSES = ['GENERATED', 'TRANSMITTED', 'ACKNOWLEDGED'] as const;

export interface PaymentFileView extends Omit<PaymentFile, 'content'> {
  bankAccountCode: string;
  bankAccountName: string;
  paymentRunNumber: string | null;
}

export interface PaymentFileDetail extends PaymentFileView {
  lines: Array<
    Omit<PaymentFileLine, 'beneficiaryAccount'> & {
      beneficiaryAccountMasked: string | null;
      paymentNumber: string;
      vendorName: string;
    }
  >;
}

/**
 * Bank payment files (Prompt #8): a batch of posted vendor payments from
 * one bank account rendered as PESONet CSV, ISO 20022 pain.001 or a
 * positive-pay register. Files never post; a payment belongs to at most one
 * live file, and status changes (transmitted / acknowledged / rejected) are
 * recorded with the bank reference.
 */
@Injectable()
export class PaymentFilesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbering: DocumentNumberingService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly config: TreasuryConfigService,
    private readonly approvals: ApprovalsService,
  ) {}

  async list(
    companyId: string,
    query: ListPaymentFilesQuery,
  ): Promise<PaginatedResult<PaymentFileView>> {
    const filters: SQL[] = [eq(paymentFiles.companyId, companyId)];
    if (query.status) filters.push(eq(paymentFiles.status, query.status));
    if (query.bankAccountId) filters.push(eq(paymentFiles.bankAccountId, query.bankAccountId));
    if (query.format) filters.push(eq(paymentFiles.format, query.format));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(paymentFiles.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, paymentFiles, where),
    ]);
    return toPaginatedResult(rows.map(decorate), total, query);
  }

  async get(companyId: string, id: string): Promise<PaymentFileDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(paymentFiles.id, id), eq(paymentFiles.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Payment file', id);
    const lines = await this.db
      .select({
        line: paymentFileLines,
        paymentNumber: vendorPayments.documentNumber,
        vendorName: vendors.name,
      })
      .from(paymentFileLines)
      .innerJoin(vendorPayments, eq(vendorPayments.id, paymentFileLines.paymentId))
      .innerJoin(vendors, eq(vendors.id, vendorPayments.vendorId))
      .where(eq(paymentFileLines.fileId, id))
      .orderBy(asc(paymentFileLines.sequence));
    return {
      ...decorate(row),
      lines: lines.map((l) => {
        const { beneficiaryAccount, ...rest } = l.line;
        return {
          ...rest,
          beneficiaryAccountMasked: beneficiaryAccount
            ? '*'.repeat(Math.max(beneficiaryAccount.length - 4, 0)) + beneficiaryAccount.slice(-4)
            : null,
          paymentNumber: l.paymentNumber,
          vendorName: l.vendorName,
        };
      }),
    };
  }

  /** The raw file for download (payment-file.manage). */
  async content(
    companyId: string,
    id: string,
  ): Promise<{ filename: string; content: string; contentType: string }> {
    const [row] = await this.db
      .select()
      .from(paymentFiles)
      .where(and(eq(paymentFiles.id, id), eq(paymentFiles.companyId, companyId)));
    if (!row) throw new NotFoundError('Payment file', id);
    return {
      filename: row.filename,
      content: row.content,
      contentType:
        row.format === 'ISO20022_PAIN001'
          ? 'application/xml; charset=utf-8'
          : 'text/csv; charset=utf-8',
    };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePaymentFileInput,
  ): Promise<PaymentFileDetail> {
    const id = await this.db.transaction(async (tx) => {
      const [bank] = await tx
        .select()
        .from(bankAccounts)
        .where(
          and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, companyId)),
        );
      if (!bank) throw new NotFoundError('Bank account', input.bankAccountId);
      const profile = await this.config.profile(companyId, bank.id, tx);
      const settings = await this.config.settings(companyId, tx);
      const [company] = await tx
        .select({ name: companies.name, organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, companyId));

      // Candidate payments: posted disbursements from this bank account, not yet in a live file.
      const filed = tx
        .select({ paymentId: paymentFileLines.paymentId })
        .from(paymentFileLines)
        .innerJoin(paymentFiles, eq(paymentFiles.id, paymentFileLines.fileId))
        .where(inArray(paymentFiles.status, [...LIVE_STATUSES]));
      const conditions: SQL[] = [
        eq(vendorPayments.companyId, companyId),
        eq(vendorPayments.status, 'POSTED'),
        eq(vendorPayments.paymentType, 'PAYMENT'),
        eq(vendorPayments.cashAccountId, bank.glAccountId),
        notInArray(vendorPayments.id, filed),
      ];
      if (input.paymentRunId) conditions.push(eq(vendorPayments.paymentRunId, input.paymentRunId));
      if (input.paymentIds?.length) conditions.push(inArray(vendorPayments.id, input.paymentIds));
      if (input.format === 'POSITIVE_PAY_CSV') conditions.push(eq(vendorPayments.method, 'CHECK'));
      const payments = await tx
        .select({ payment: vendorPayments, vendor: vendors })
        .from(vendorPayments)
        .innerJoin(vendors, eq(vendors.id, vendorPayments.vendorId))
        .where(and(...conditions))
        .orderBy(asc(vendorPayments.documentNumber));
      if (!payments.length)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'No posted, unfiled vendor payments from this bank account match the selection.',
        );
      if (payments.some((p) => p.payment.currency !== bank.currency))
        throw new BusinessRuleError(
          ErrorCodes.CURRENCY_MISMATCH,
          `Every payment in a file must be in the bank account currency (${bank.currency}).`,
        );

      const banks = await tx
        .select()
        .from(vendorBankAccounts)
        .where(
          and(
            inArray(
              vendorBankAccounts.vendorId,
              payments.map((p) => p.vendor.id),
            ),
            eq(vendorBankAccounts.status, 'ACTIVE'),
          ),
        )
        .orderBy(desc(vendorBankAccounts.isPrimary), asc(vendorBankAccounts.createdAt));
      const bankByVendor = new Map<string, (typeof banks)[number]>();
      for (const b of banks) if (!bankByVendor.has(b.vendorId)) bankByVendor.set(b.vendorId, b);
      const missing = payments.filter(
        (p) => input.format !== 'POSITIVE_PAY_CSV' && !bankByVendor.get(p.vendor.id),
      );
      if (missing.length)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `No settlement bank account on file for: ${[...new Set(missing.map((m) => m.vendor.name))].join(', ')}.`,
          { vendorIds: [...new Set(missing.map((m) => m.vendor.id))] },
        );

      const remittanceFor = async (paymentId: string) => {
        const bills = await tx
          .select({ ref: paymentRunLines.billId })
          .from(paymentRunLines)
          .where(eq(paymentRunLines.paymentId, paymentId));
        return bills.length ? `${bills.length} bill(s)` : 'Vendor payment';
      };
      const entries: PaymentFileEntry[] = [];
      let seq = 1;
      for (const p of payments) {
        const vb = bankByVendor.get(p.vendor.id);
        entries.push({
          sequence: seq++,
          paymentNumber: p.payment.documentNumber,
          amount: Money.of(p.payment.amount, bank.currency).toString(),
          beneficiaryName: vb?.accountName ?? p.vendor.legalName ?? p.vendor.name,
          beneficiaryBank: vb?.bankName ?? null,
          beneficiaryAccount: vb?.accountNumber ?? null,
          beneficiaryRouting: vb?.routingCode ?? null,
          remittanceInfo: p.payment.reference ?? (await remittanceFor(p.payment.id)),
        });
      }
      const totals = fileTotals(entries, bank.currency);
      const valueDate = input.valueDate ?? businessToday();
      const documentNumber = await this.numbering.allocate(
        companyId,
        'PMF',
        Number(valueDate.slice(0, 4)),
        tx,
      );
      const header = {
        fileNumber: documentNumber,
        valueDate,
        currency: bank.currency,
        originatorName: settings.originatorName ?? company!.name,
        originatorId: profile.originatorId,
        originatorAccount: bank.accountNumber,
        originatorRouting: profile.routingCode,
        totalAmount: totals.total,
        count: totals.count,
      };
      const content =
        input.format === 'ISO20022_PAIN001'
          ? renderPain001(header, entries)
          : input.format === 'POSITIVE_PAY_CSV'
            ? renderPositivePayCsv(header, entries)
            : renderPesonetCsv(header, entries);
      const filename = `${documentNumber}.${input.format === 'ISO20022_PAIN001' ? 'xml' : 'csv'}`;
      const [file] = await tx
        .insert(paymentFiles)
        .values({
          companyId,
          documentNumber,
          format: input.format,
          bankAccountId: bank.id,
          paymentRunId: input.paymentRunId ?? null,
          valueDate,
          currency: bank.currency,
          totalAmount: totals.total,
          paymentCount: totals.count,
          filename,
          content,
          checksum: sha256(content),
          description: input.description ?? null,
          createdBy: actor.id,
        })
        .returning();
      // Transmission may be workflow-gated (PAYMENT_FILE rules on the file total): open the
      // request with the file so approvers see it before anything reaches the bank.
      const request = await this.approvals.open(tx, this.workflowRef(companyId, file!, actor.id));
      if (request)
        await this.notifications.notify(
          {
            organizationId: company!.organizationId,
            eventType: 'PAYMENT_FILE_APPROVAL_REQUIRED',
            severity: 'INFO',
            title: `Payment file ${documentNumber} awaits approval`,
            body: `${bank.currency} ${totals.total.toString()} in ${totals.count} payment(s), generated by ${actor.email}.`,
            link: `/treasury/payment-files`,
            entityType: 'PaymentFile',
            entityId: file!.id,
            permission: 'payment-file.manage',
            companyId,
            dedupeKey: `payment-file-approval:${file!.id}`,
          },
          tx,
        );
      await tx.insert(paymentFileLines).values(
        entries.map((e, i) => ({
          fileId: file!.id,
          paymentId: payments[i]!.payment.id,
          sequence: e.sequence,
          amount: e.amount,
          beneficiaryName: e.beneficiaryName,
          beneficiaryBank: e.beneficiaryBank,
          beneficiaryAccount: e.beneficiaryAccount,
          beneficiaryRouting: e.beneficiaryRouting,
          remittanceInfo: e.remittanceInfo,
        })),
      );
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'PaymentFile',
          entityId: file!.id,
          newValue: {
            documentNumber,
            format: input.format,
            bankAccount: bank.code,
            total: totals.total,
            payments: totals.count,
            checksum: file!.checksum,
          },
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'payment_file.generated',
        companyId,
        dedupeKey: 'payment_file.generated:' + file!.id,
        payload: {
          fileId: file!.id,
          documentNumber,
          format: input.format,
          bankAccountId: bank.id,
          total: totals.total,
          currency: bank.currency,
          payments: totals.count,
        },
      });
      return file!.id;
    });
    return this.get(companyId, id);
  }

  /** GENERATED -> TRANSMITTED -> ACKNOWLEDGED | REJECTED; CANCELLED from GENERATED. Rejected / cancelled payments become filable again. */
  private workflowRef(companyId: string, file: PaymentFile, requestedBy: string) {
    return {
      companyId,
      documentType: 'PAYMENT_FILE' as const,
      documentId: file.id,
      documentNumber: file.documentNumber,
      amount: file.totalAmount,
      currency: file.currency,
      requestedBy,
    };
  }

  async setStatus(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: PaymentFileStatusInput,
  ): Promise<PaymentFileDetail> {
    await this.db.transaction(async (tx) => {
      const [file] = await tx
        .select()
        .from(paymentFiles)
        .where(and(eq(paymentFiles.id, id), eq(paymentFiles.companyId, companyId)))
        .for('update');
      if (!file) throw new NotFoundError('Payment file', id);
      const allowed: Record<string, PaymentFile['status'][]> = {
        TRANSMITTED: ['GENERATED'],
        ACKNOWLEDGED: ['TRANSMITTED'],
        REJECTED: ['TRANSMITTED'],
        CANCELLED: ['GENERATED'],
      };
      if (!allowed[input.status]!.includes(file.status))
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${file.documentNumber} cannot move to ${input.status} from ${file.status}.`,
        );
      // Money leaves on transmission: a configured workflow must have approved the file first.
      if (input.status === 'TRANSMITTED')
        await this.approvals.assertApproved(
          tx,
          this.workflowRef(companyId, file, file.createdBy ?? actor.id),
        );
      if (input.status === 'CANCELLED') await this.approvals.cancelFor(tx, 'PAYMENT_FILE', id);
      await tx
        .update(paymentFiles)
        .set({
          status: input.status,
          bankReference: input.bankReference ?? file.bankReference,
          statusNote: input.note ?? null,
          ...(input.status === 'TRANSMITTED'
            ? { transmittedBy: actor.id, transmittedAt: new Date() }
            : {}),
          ...(input.status === 'ACKNOWLEDGED' ? { acknowledgedAt: new Date() } : {}),
        })
        .where(eq(paymentFiles.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PaymentFile',
          entityId: id,
          previousValue: { status: file.status },
          newValue: { status: input.status, bankReference: input.bankReference ?? null },
          metadata: {
            documentNumber: file.documentNumber,
            editor: actor.email,
            reason: input.note ?? null,
          },
          companyId,
        },
        tx,
      );
      const event = (
        {
          TRANSMITTED: 'payment_file.transmitted',
          ACKNOWLEDGED: 'payment_file.acknowledged',
          REJECTED: 'payment_file.rejected',
        } as const
      )[input.status as 'TRANSMITTED' | 'ACKNOWLEDGED' | 'REJECTED'];
      if (event)
        await this.outbox.enqueue(tx, {
          eventType: event,
          companyId,
          dedupeKey: `${event}:${id}`,
          payload: {
            fileId: id,
            documentNumber: file.documentNumber,
            status: input.status,
            bankReference: input.bankReference ?? null,
            total: file.totalAmount,
            currency: file.currency,
          },
        });
      if (input.status === 'REJECTED') {
        const [company] = await tx
          .select({ organizationId: companies.organizationId })
          .from(companies)
          .where(eq(companies.id, companyId));
        await this.notifications.notify(
          {
            organizationId: company!.organizationId,
            eventType: 'PAYMENT_FILE_REJECTED',
            severity: 'ERROR',
            title: `Payment file ${file.documentNumber} rejected by the bank`,
            body: `${file.currency} ${file.totalAmount} across ${file.paymentCount} payment(s)${input.note ? `: ${input.note}` : ''}. The payments are still posted - reissue or void them.`,
            link: `/treasury/payment-files`,
            entityType: 'PaymentFile',
            entityId: id,
            permission: 'payment-file.manage',
            companyId,
            dedupeKey: `payment-file-rejected:${id}`,
          },
          tx,
        );
      }
    });
    return this.get(companyId, id);
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        file: paymentFiles,
        bankAccountCode: bankAccounts.code,
        bankAccountName: bankAccounts.name,
        paymentRunNumber: paymentRuns.documentNumber,
      })
      .from(paymentFiles)
      .innerJoin(bankAccounts, eq(bankAccounts.id, paymentFiles.bankAccountId))
      .leftJoin(paymentRuns, eq(paymentRuns.id, paymentFiles.paymentRunId));
  }
}

function decorate(row: {
  file: PaymentFile;
  bankAccountCode: string;
  bankAccountName: string;
  paymentRunNumber: string | null;
}): PaymentFileView {
  const { content, ...rest } = row.file;
  void content;
  return {
    ...rest,
    bankAccountCode: row.bankAccountCode,
    bankAccountName: row.bankAccountName,
    paymentRunNumber: row.paymentRunNumber,
  };
}
