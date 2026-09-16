import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type DisputeStatus, type PaginatedResult } from '@accounting/types';
import type {
  CreateDisputeInput,
  ListDisputesQuery,
  UpdateDisputeInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  collectionActivities,
  collectionCases,
  companies,
  customers,
  invoiceDisputes,
  invoices,
  type InvoiceDispute,
} from '@/database/schema';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';

const MODULE = 'RECEIVABLES';
const OPEN: DisputeStatus[] = ['OPEN', 'INVESTIGATING'];
const FLOW: Record<DisputeStatus, DisputeStatus[]> = {
  OPEN: ['INVESTIGATING', 'RESOLVED', 'CLOSED'],
  INVESTIGATING: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'INVESTIGATING'],
  CLOSED: [],
};

export interface DisputeView extends InvoiceDispute {
  customerCode: string;
  customerName: string;
  invoiceNumber: string;
  invoiceTotal: string;
  invoiceBalance: string;
  creditNoteNumber: string | null;
  assigneeName: string | null;
}

/**
 * Invoice disputes (Prompt #6): OPEN -> INVESTIGATING -> RESOLVED -> CLOSED.
 * A dispute never edits the invoice; a resolution that credits the customer
 * points at a posted credit note raised through the normal document flow.
 * Open disputes pause dunning for the invoice and flag it on every screen.
 */
@Injectable()
export class DisputesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbering: DocumentNumberingService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(companyId: string, query: ListDisputesQuery): Promise<PaginatedResult<DisputeView>> {
    const filters: SQL[] = [eq(invoiceDisputes.companyId, companyId)];
    if (query.customerId) filters.push(eq(invoiceDisputes.customerId, query.customerId));
    if (query.invoiceId) filters.push(eq(invoiceDisputes.invoiceId, query.invoiceId));
    if (query.status) filters.push(eq(invoiceDisputes.status, query.status));
    if (query.openOnly) filters.push(inArray(invoiceDisputes.status, OPEN));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(invoiceDisputes.documentNumber, term),
          ilike(invoices.documentNumber, term),
          ilike(customers.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const [rows, count] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(
          query.sortDir === 'asc'
            ? asc(invoiceDisputes.createdAt)
            : desc(invoiceDisputes.createdAt),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(invoiceDisputes)
        .innerJoin(invoices, eq(invoices.id, invoiceDisputes.invoiceId))
        .innerJoin(customers, eq(customers.id, invoiceDisputes.customerId))
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(count[0]?.n ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<DisputeView> {
    const [row] = await this.viewQuery().where(
      and(eq(invoiceDisputes.id, id), eq(invoiceDisputes.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Dispute', id);
    return row;
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateDisputeInput,
  ): Promise<DisputeView> {
    const id = await this.db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, input.invoiceId), eq(invoices.companyId, companyId)))
        .for('update');
      if (!invoice) throw new NotFoundError('Invoice', input.invoiceId);
      if (
        invoice.documentType === 'CREDIT_NOTE' ||
        invoice.status === 'VOID' ||
        invoice.accountingStatus !== 'POSTED'
      )
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${invoice.documentNumber} is not a posted, open invoice.`,
        );
      const [dup] = await tx
        .select({ id: invoiceDisputes.id })
        .from(invoiceDisputes)
        .where(
          and(eq(invoiceDisputes.invoiceId, invoice.id), inArray(invoiceDisputes.status, OPEN)),
        );
      if (dup)
        throw new BusinessRuleError(
          ErrorCodes.INVOICE_DISPUTED,
          `${invoice.documentNumber} already has an open dispute.`,
          { disputeId: dup.id },
        );
      const balance = Money.of(invoice.total, invoice.currency).subtract(
        Money.of(invoice.allocatedAmount, invoice.currency),
      );
      const amount = input.amount ? Money.parse(input.amount, invoice.currency) : balance;
      if (amount.greaterThan(Money.of(invoice.total, invoice.currency)))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The disputed amount cannot exceed the invoice total.',
        );
      const documentNumber = await this.numbering.allocate(
        companyId,
        'DSP',
        new Date().getFullYear(),
        tx,
      );
      const [openCase] = await tx
        .select({ id: collectionCases.id })
        .from(collectionCases)
        .where(
          and(
            eq(collectionCases.customerId, invoice.customerId),
            inArray(collectionCases.status, [
              'NEW',
              'CONTACTED',
              'PROMISED',
              'ESCALATED',
              'DISPUTED',
            ]),
          ),
        );
      const [created] = await tx
        .insert(invoiceDisputes)
        .values({
          companyId,
          documentNumber,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          caseId: openCase?.id ?? null,
          reason: input.reason,
          currency: invoice.currency,
          amount: amount.toString(),
          description: input.description,
          raisedBy: input.raisedBy ?? null,
          assigneeId: input.assigneeId ?? null,
          openedBy: actor.id,
        })
        .returning();
      if (openCase) {
        await tx
          .update(collectionCases)
          .set({ status: 'DISPUTED' })
          .where(eq(collectionCases.id, openCase.id));
        await tx.insert(collectionActivities).values({
          caseId: openCase.id,
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          activityType: 'DISPUTE',
          summary: `Dispute ${documentNumber} opened on ${invoice.documentNumber} (${input.reason.toLowerCase().replace(/_/g, ' ')})`,
          details: input.description,
          performedBy: actor.id,
        });
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'InvoiceDispute',
          entityId: created!.id,
          newValue: {
            documentNumber,
            invoice: invoice.documentNumber,
            reason: input.reason,
            amount: amount.toString(),
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'invoice.disputed',
        companyId,
        dedupeKey: 'invoice.disputed:' + created!.id,
        payload: {
          disputeId: created!.id,
          documentNumber,
          invoiceId: invoice.id,
          invoiceNumber: invoice.documentNumber,
          customerId: invoice.customerId,
          reason: input.reason,
          amount: amount.toString(),
          currency: invoice.currency,
        },
      });
      const [company] = await tx
        .select({ organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (company)
        await this.notifications.notify(
          {
            organizationId: company.organizationId,
            eventType: 'DISPUTE_OPENED',
            severity: 'WARNING',
            title: `Dispute ${documentNumber} on ${invoice.documentNumber}`,
            body: `${input.reason.replace(/_/g, ' ')}: ${input.description.slice(0, 200)}`,
            link: `/receivables/disputes/${created!.id}`,
            entityType: 'InvoiceDispute',
            entityId: created!.id,
            userIds: input.assigneeId ? [input.assigneeId] : undefined,
            permission: input.assigneeId ? undefined : P['dispute.manage'],
            companyId,
            dedupeKey: `dispute:${created!.id}`,
          },
          tx,
        );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateDisputeInput,
  ): Promise<DisputeView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(invoiceDisputes)
        .where(and(eq(invoiceDisputes.id, id), eq(invoiceDisputes.companyId, companyId)))
        .for('update');
      if (!existing) throw new NotFoundError('Dispute', id);
      const patch: Partial<typeof invoiceDisputes.$inferInsert> = {};
      if (input.assigneeId !== undefined) patch.assigneeId = input.assigneeId;
      if (input.resolutionNotes !== undefined)
        patch.resolutionNotes = input.resolutionNotes ?? null;
      if (input.amount !== undefined)
        patch.amount = Money.parse(input.amount, existing.currency).toString();
      if (input.creditNoteId !== undefined) {
        if (input.creditNoteId) {
          const [cn] = await tx
            .select({
              id: invoices.id,
              customerId: invoices.customerId,
              documentType: invoices.documentType,
              accountingStatus: invoices.accountingStatus,
            })
            .from(invoices)
            .where(and(eq(invoices.id, input.creditNoteId), eq(invoices.companyId, companyId)));
          if (!cn || cn.customerId !== existing.customerId || cn.documentType !== 'CREDIT_NOTE')
            throw new NotFoundError('Credit note', input.creditNoteId);
          if (cn.accountingStatus !== 'POSTED')
            throw new BusinessRuleError(
              ErrorCodes.DOCUMENT_INVALID_STATE,
              'The settling credit note must be posted.',
            );
        }
        patch.creditNoteId = input.creditNoteId;
      }
      if (input.resolution !== undefined) patch.resolution = input.resolution;
      if (input.status && input.status !== existing.status) {
        if (!FLOW[existing.status].includes(input.status))
          throw new BusinessRuleError(
            ErrorCodes.DOCUMENT_INVALID_STATE,
            `A ${existing.status} dispute cannot move to ${input.status}.`,
          );
        if (input.status === 'RESOLVED' || input.status === 'CLOSED') {
          const resolution = input.resolution ?? existing.resolution;
          if (!resolution)
            throw new BusinessRuleError(
              ErrorCodes.VALIDATION_FAILED,
              'Choose a resolution before resolving the dispute.',
            );
          if (
            (resolution === 'CREDIT_NOTE' || resolution === 'PARTIAL_CREDIT') &&
            !(input.creditNoteId ?? existing.creditNoteId)
          )
            throw new BusinessRuleError(
              ErrorCodes.VALIDATION_FAILED,
              'A credit resolution must reference the posted credit note.',
            );
          if (input.status === 'RESOLVED' || !existing.resolvedAt) {
            patch.resolvedBy = actor.id;
            patch.resolvedAt = new Date();
          }
        }
        if (input.status === 'CLOSED') patch.closedAt = new Date();
        patch.status = input.status;
      }
      await tx.update(invoiceDisputes).set(patch).where(eq(invoiceDisputes.id, id));
      if (patch.status && existing.caseId) {
        await tx.insert(collectionActivities).values({
          caseId: existing.caseId,
          customerId: existing.customerId,
          invoiceId: existing.invoiceId,
          activityType: 'DISPUTE',
          summary: `Dispute ${existing.documentNumber} ${patch.status.toLowerCase()}${(patch.resolution ?? existing.resolution) ? ` (${(patch.resolution ?? existing.resolution)!.toLowerCase().replace(/_/g, ' ')})` : ''}`,
          details: input.resolutionNotes ?? null,
          performedBy: actor.id,
        });
        if (patch.status === 'RESOLVED' || patch.status === 'CLOSED') {
          const [stillOpen] = await tx
            .select({ n: sql<number>`count(*)` })
            .from(invoiceDisputes)
            .where(
              and(
                eq(invoiceDisputes.customerId, existing.customerId),
                inArray(invoiceDisputes.status, OPEN),
                sql`${invoiceDisputes.id} <> ${id}`,
              ),
            );
          if (Number(stillOpen?.n ?? 0) === 0)
            await tx
              .update(collectionCases)
              .set({ status: 'CONTACTED' })
              .where(
                and(
                  eq(collectionCases.id, existing.caseId),
                  eq(collectionCases.status, 'DISPUTED'),
                ),
              );
        }
      }
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'InvoiceDispute',
          entityId: id,
          previousValue: { status: existing.status, resolution: existing.resolution },
          newValue: patch,
          metadata: { documentNumber: existing.documentNumber, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Open disputes on an invoice (used by write-offs and dunning to stand down). */
  async openDisputeCount(tx: DbExecutor, invoiceId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(invoiceDisputes)
      .where(and(eq(invoiceDisputes.invoiceId, invoiceId), inArray(invoiceDisputes.status, OPEN)));
    return Number(row?.n ?? 0);
  }

  private viewQuery() {
    return this.db
      .select({
        id: invoiceDisputes.id,
        companyId: invoiceDisputes.companyId,
        documentNumber: invoiceDisputes.documentNumber,
        invoiceId: invoiceDisputes.invoiceId,
        customerId: invoiceDisputes.customerId,
        caseId: invoiceDisputes.caseId,
        status: invoiceDisputes.status,
        reason: invoiceDisputes.reason,
        currency: invoiceDisputes.currency,
        amount: invoiceDisputes.amount,
        description: invoiceDisputes.description,
        raisedBy: invoiceDisputes.raisedBy,
        assigneeId: invoiceDisputes.assigneeId,
        resolution: invoiceDisputes.resolution,
        resolutionNotes: invoiceDisputes.resolutionNotes,
        creditNoteId: invoiceDisputes.creditNoteId,
        openedBy: invoiceDisputes.openedBy,
        resolvedBy: invoiceDisputes.resolvedBy,
        resolvedAt: invoiceDisputes.resolvedAt,
        closedAt: invoiceDisputes.closedAt,
        createdAt: invoiceDisputes.createdAt,
        updatedAt: invoiceDisputes.updatedAt,
        customerCode: customers.code,
        customerName: customers.name,
        invoiceNumber: invoices.documentNumber,
        invoiceTotal: invoices.total,
        invoiceBalance: sql<string>`${invoices.total} - ${invoices.allocatedAmount}`,
        creditNoteNumber: sql<
          string | null
        >`(select document_number from invoices c where c.id = ${invoiceDisputes.creditNoteId})`,
        assigneeName: sql<
          string | null
        >`(select first_name || ' ' || last_name from users u where u.id = ${invoiceDisputes.assigneeId})`,
      })
      .from(invoiceDisputes)
      .innerJoin(invoices, eq(invoices.id, invoiceDisputes.invoiceId))
      .innerJoin(customers, eq(customers.id, invoiceDisputes.customerId));
  }
}
