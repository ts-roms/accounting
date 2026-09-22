import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { P, type AiDocumentKind, type PaginatedResult } from '@accounting/types';
import {
  aiExtractedFieldsSchema,
  type AiExtractedFieldsInput,
  type DraftFromAiDocumentInput,
  type ListAiDocumentsQuery,
  type UpdateAiDocumentInput,
} from '@accounting/validation';
import { Money } from '@accounting/money';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError, PermissionDeniedError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  aiDocuments,
  users,
  vendorBills,
  vendors,
  expenseClaims,
  type AiDocument,
} from '@/database/schema';
import { AttachmentsService, type UploadedFile } from '@/modules/attachments/attachments.service';
import { AuditService } from '@/modules/audit/audit.service';
import { ExpenseClaimsService } from '@/modules/budgeting/expense-claims.service';
import { BillsService } from '@/modules/payables/bills.service';
import { businessToday } from '@/common/time/clock';
import { AiClassifierService } from './ai-classifier.service';
import { AiProviderService } from './ai-provider.service';
import { OcrService } from './ocr.service';
import type { AccountSuggestion } from './ai.logic';

const MODULE = 'AI';

/** What the intake stores per document: the reviewed fields plus the classifier's hints. */
export interface ExtractedPayload extends AiExtractedFieldsInput {
  lineSuggestions?: (AccountSuggestion | null)[];
}

export interface AiDocumentView extends Omit<AiDocument, 'extracted' | 'sourceText'> {
  extracted: ExtractedPayload;
  vendorName: string | null;
  draftNumber: string | null;
  createdByName: string | null;
}

export interface AiDocumentDetail extends AiDocumentView {
  sourceText: string | null;
}

const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'application/json']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * OCR / extraction intake: a file comes in, fields come out, a person reviews
 * them and turns the document into a DRAFT bill or expense claim through the
 * ordinary services (their permissions, numbering, tax and approval rules all
 * apply). The intake itself never posts and never bypasses a draft.
 */
@Injectable()
export class AiIntakeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
    private readonly provider: AiProviderService,
    private readonly ocr: OcrService,
    private readonly classifier: AiClassifierService,
    private readonly bills: BillsService,
    private readonly claims: ExpenseClaimsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AiIntakeService.name);
  }

  async list(
    companyId: string,
    query: ListAiDocumentsQuery,
  ): Promise<PaginatedResult<AiDocumentView>> {
    const filters: SQL[] = [eq(aiDocuments.companyId, companyId)];
    if (query.status) filters.push(eq(aiDocuments.status, query.status));
    if (query.kind) filters.push(eq(aiDocuments.kind, query.kind));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(aiDocuments.fileName, term),
          sql`${aiDocuments.extracted}->>'vendorName' ilike ${term}`,
        )!,
      );
    }
    const where = and(...filters);
    const [rows, [count]] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(desc(aiDocuments.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(aiDocuments)
        .where(where),
    ]);
    return toPaginatedResult(
      rows.map((r) => this.toView(r)),
      count?.total ?? 0,
      query,
    );
  }

  async get(companyId: string, id: string): Promise<AiDocumentDetail> {
    const [row] = await this.viewQuery().where(
      and(eq(aiDocuments.id, id), eq(aiDocuments.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('AI document', id);
    return { ...this.toView(row), sourceText: row.doc.sourceText };
  }

  /** Stores the file, extracts what it can and pre-fills account suggestions. Nothing is posted. */
  async intake(
    companyId: string,
    actor: AuthenticatedUser,
    file: UploadedFile,
    kindHint?: AiDocumentKind,
  ): Promise<AiDocumentDetail> {
    if (!file?.buffer?.length)
      throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'No file was uploaded.');
    const [created] = await this.db
      .insert(aiDocuments)
      .values({
        companyId,
        status: 'NEEDS_REVIEW',
        kind: kindHint ?? 'UNKNOWN',
        fileName: file.originalname,
        mimeType: file.mimetype,
        createdBy: actor.id,
      })
      .returning();
    const doc = created!;
    const attachment = await this.attachments.upload(
      companyId,
      actor,
      'AI_DOCUMENT',
      doc.id,
      file,
      'AI intake source',
    );

    let sourceText: string | null = null;
    let error: string | null = null;
    try {
      sourceText = await this.textOf(file);
    } catch (err) {
      error = `Could not read the file: ${(err as Error).message}`;
      this.logger.warn({ err, id: doc.id }, 'AI intake text extraction failed');
    }
    const image = IMAGE_TYPES.has(file.mimetype)
      ? { mimeType: file.mimetype, buffer: file.buffer }
      : null;
    // No model to read the picture: OCR it locally so the text extractor has
    // something to work from (a model backend reads the image itself).
    let ocrConfidence: number | null = null;
    if (image && !sourceText && this.provider.name !== 'ANTHROPIC') {
      const read = await this.ocr.recognize(image.buffer);
      if (read) {
        sourceText = read.text;
        ocrConfidence = read.confidence;
      } else if (!this.ocr.enabled && !error)
        error =
          'Images need a model backend or OCR_PROVIDER=TESSERACT to be read; fill the fields in manually.';
    }
    const extraction =
      sourceText || image
        ? await this.provider.extract(sourceText, image)
        : {
            kind: 'UNKNOWN' as const,
            fields: { lines: [] },
            confidence: 0,
            provider: 'HEURISTIC' as const,
            model: null,
          };
    if (!sourceText && !image && !error)
      error = 'This file type cannot be read for extraction; fill the fields in manually.';
    if (ocrConfidence !== null)
      this.logger.info(
        { id: doc.id, ocrConfidence, chars: sourceText?.length ?? 0 },
        'AI intake read the image with OCR',
      );

    const kind = kindHint ?? extraction.kind;
    const vendorId = await this.matchVendor(companyId, extraction.fields);
    const extracted = await this.withSuggestions(companyId, extraction.fields, vendorId);
    const status =
      extraction.confidence >= 0.6 && (extracted.total || extracted.lines.length)
        ? 'EXTRACTED'
        : 'NEEDS_REVIEW';

    await this.db.transaction(async (tx) => {
      await tx
        .update(aiDocuments)
        .set({
          status,
          kind,
          attachmentId: attachment.id,
          sourceText,
          extracted,
          confidence: extraction.confidence.toFixed(4),
          provider: extraction.provider,
          model: extraction.model,
          vendorId,
          error,
        })
        .where(eq(aiDocuments.id, doc.id));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'AiDocument',
          entityId: doc.id,
          newValue: {
            fileName: file.originalname,
            kind,
            status,
            confidence: extraction.confidence,
            provider: extraction.provider,
          },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, doc.id);
  }

  /** A reviewer corrects fields; re-runs the account hints for changed lines. */
  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateAiDocumentInput,
  ): Promise<AiDocumentDetail> {
    await this.db.transaction(async (tx) => {
      const [doc] = await tx
        .select()
        .from(aiDocuments)
        .where(and(eq(aiDocuments.id, id), eq(aiDocuments.companyId, companyId)))
        .for('update');
      if (!doc) throw new NotFoundError('AI document', id);
      if (doc.status === 'DRAFTED' || doc.status === 'DISMISSED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `A ${doc.status.toLowerCase()} document can no longer be edited.`,
        );
      const current = doc.extracted as ExtractedPayload;
      const vendorId = input.vendorId === undefined ? doc.vendorId : input.vendorId;
      const fields = input.extracted ? aiExtractedFieldsSchema.parse(input.extracted) : current;
      const extracted = input.extracted
        ? await this.withSuggestions(companyId, fields, vendorId, tx)
        : { ...current };
      await tx
        .update(aiDocuments)
        .set({
          kind: input.kind ?? doc.kind,
          extracted,
          vendorId,
          status: 'EXTRACTED',
          reviewedBy: actor.id,
          reviewedAt: new Date(),
        })
        .where(eq(aiDocuments.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'AiDocument',
          entityId: id,
          previousValue: { kind: doc.kind, vendorId: doc.vendorId },
          newValue: { kind: input.kind ?? doc.kind, vendorId },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Creates the DRAFT bill / claim through the owning service. The caller
   * needs that service's create permission; approval and posting stay manual.
   */
  async draft(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: DraftFromAiDocumentInput,
  ): Promise<AiDocumentDetail> {
    const doc = await this.get(companyId, id);
    if (doc.status === 'DRAFTED')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        'A draft was already created from this document.',
      );
    if (doc.status === 'DISMISSED')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        'This document was dismissed.',
      );
    const x = doc.extracted;
    const today = businessToday();
    const lines = x.lines.length
      ? x.lines
      : x.total
        ? [
            {
              description: x.reference ? `Per document ${x.reference}` : `Per ${doc.fileName}`,
              quantity: '1',
              unitPrice: x.subtotal ?? x.total,
              accountId: null,
              taxCodeId: null,
            },
          ]
        : [];
    if (!lines.length)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'Add at least one line (or a total) before drafting.',
      );
    const warnings: string[] = [];

    if (input.kind === 'BILL') {
      if (!actor.permissions.has(P['bill.create']))
        throw new PermissionDeniedError([P['bill.create']]);
      const vendorId = input.vendorId ?? doc.vendorId;
      if (!vendorId)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Match the document to a vendor before drafting a bill.',
        );
      const [vendor] = await this.db
        .select()
        .from(vendors)
        .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)));
      if (!vendor) throw new NotFoundError('Vendor', vendorId);
      const billLines = lines.map((l, i) => {
        const accountId =
          l.accountId ?? x.lineSuggestions?.[i]?.accountId ?? vendor.defaultExpenseAccountId;
        if (!accountId)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            `Line ${i + 1} needs a posting account.`,
          );
        return {
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountPercent: '0',
          accountId,
          taxCodeId: l.taxCodeId ?? undefined,
        };
      });
      const detail = await this.bills.create(companyId, actor, {
        documentType: 'INVOICE',
        documentDate: x.documentDate ?? today,
        dueDate: x.dueDate ?? undefined,
        reference: x.reference ?? undefined,
        vendorInvoiceNumber: x.reference ?? undefined,
        description: `From AI intake: ${doc.fileName}`,
        branchId: input.branchId ?? undefined,
        vendorId,
        lines: billLines,
      });
      if (
        x.total &&
        !Money.of(detail.total, detail.currency).equals(Money.of(x.total, detail.currency))
      )
        warnings.push(
          `Draft total ${detail.total} differs from the document total ${x.total}; review the lines and tax codes.`,
        );
      await this.finishDraft(
        companyId,
        actor,
        doc.id,
        { draftBillId: detail.id },
        'BILL',
        detail.id,
        warnings,
      );
    } else {
      if (!actor.permissions.has(P['expense-claim.create']))
        throw new PermissionDeniedError([P['expense-claim.create']]);
      const claimLines = lines.map((l, i) => {
        const accountId = l.accountId ?? x.lineSuggestions?.[i]?.accountId;
        if (!accountId)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            `Line ${i + 1} needs a posting account.`,
          );
        return {
          expenseDate: x.documentDate ?? today,
          description: l.description,
          accountId,
          amount: Money.of(l.quantity, 'PHP').multiply(l.unitPrice).toString(),
          taxCodeId: l.taxCodeId ?? undefined,
          merchant: x.vendorName ?? undefined,
          receiptReference: x.reference ?? undefined,
        };
      });
      const detail = await this.claims.create(companyId, actor, {
        claimantUserId: input.claimantUserId,
        claimDate: x.documentDate ?? today,
        purpose: x.vendorName ? `Receipt from ${x.vendorName}` : `Receipt ${doc.fileName}`,
        notes: `From AI intake: ${doc.fileName}`,
        branchId: input.branchId ?? undefined,
        lines: claimLines,
      });
      await this.finishDraft(
        companyId,
        actor,
        doc.id,
        { draftExpenseClaimId: detail.id },
        'EXPENSE_CLAIM',
        detail.id,
        warnings,
      );
    }
    const result = await this.get(companyId, id);
    return Object.assign(result, { warnings });
  }

  async dismiss(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    reason?: string,
  ): Promise<AiDocumentDetail> {
    await this.db.transaction(async (tx) => {
      const [doc] = await tx
        .select()
        .from(aiDocuments)
        .where(and(eq(aiDocuments.id, id), eq(aiDocuments.companyId, companyId)))
        .for('update');
      if (!doc) throw new NotFoundError('AI document', id);
      if (doc.status === 'DRAFTED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'A drafted document cannot be dismissed; void the draft instead.',
        );
      await tx
        .update(aiDocuments)
        .set({
          status: 'DISMISSED',
          reviewedBy: actor.id,
          reviewedAt: new Date(),
          error: reason ?? doc.error,
        })
        .where(eq(aiDocuments.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'AiDocument',
          entityId: id,
          previousValue: { status: doc.status },
          newValue: { status: 'DISMISSED', reason },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  // ----------------------------------------------------------------- helpers

  private async finishDraft(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    link: { draftBillId?: string; draftExpenseClaimId?: string },
    entityType: 'BILL' | 'EXPENSE_CLAIM',
    entityId: string,
    warnings: string[],
  ) {
    await this.db.transaction(async (tx) => {
      const [doc] = await tx.select().from(aiDocuments).where(eq(aiDocuments.id, id)).for('update');
      await tx
        .update(aiDocuments)
        .set({
          ...link,
          status: 'DRAFTED',
          kind: entityType,
          reviewedBy: actor.id,
          reviewedAt: new Date(),
        })
        .where(eq(aiDocuments.id, id));
      if (doc?.attachmentId)
        await this.attachments.relink(tx, companyId, doc.attachmentId, entityType, entityId);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'AiDocument',
          entityId: id,
          newValue: { status: 'DRAFTED', ...link, warnings },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
  }

  private async textOf(file: UploadedFile): Promise<string | null> {
    if (TEXT_TYPES.has(file.mimetype)) return file.buffer.toString('utf8');
    if (file.mimetype === 'application/pdf') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (
        b: Buffer,
      ) => Promise<{ text: string }>;
      const parsed = await pdfParse(file.buffer);
      return parsed.text?.trim() ? parsed.text : null;
    }
    return null;
  }

  /** Exact TIN match first, then a name match; null leaves the choice to the reviewer. */
  private async matchVendor(
    companyId: string,
    fields: AiExtractedFieldsInput,
  ): Promise<string | null> {
    if (fields.vendorTaxId) {
      const [byTin] = await this.db
        .select({ id: vendors.id })
        .from(vendors)
        .where(
          and(
            eq(vendors.companyId, companyId),
            eq(vendors.taxIdentificationNumber, fields.vendorTaxId),
          ),
        )
        .limit(1);
      if (byTin) return byTin.id;
    }
    if (!fields.vendorName) return null;
    const needle = fields.vendorName
      .replace(/[^a-z0-9 ]/gi, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(' ');
    if (needle.length < 3) return null;
    const [byName] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          eq(vendors.companyId, companyId),
          or(ilike(vendors.name, `%${needle}%`), ilike(vendors.legalName, `%${needle}%`)),
        ),
      )
      .orderBy(vendors.name)
      .limit(1);
    return byName?.id ?? null;
  }

  private async withSuggestions(
    companyId: string,
    fields: AiExtractedFieldsInput,
    vendorId: string | null,
    executor = this.db,
  ): Promise<ExtractedPayload> {
    const lineSuggestions: (AccountSuggestion | null)[] = [];
    const fallback = vendorId ? await this.vendorDefault(companyId, vendorId, executor) : null;
    for (const line of fields.lines) {
      const [best] = await this.classifier.classify(
        companyId,
        {
          description: line.description,
          side: 'PURCHASE',
          partyId: vendorId ?? undefined,
          limit: 1,
        },
        executor,
      );
      // A party-only guess (no description overlap) loses to the vendor's configured default account.
      lineSuggestions.push(
        best && (best.confidence >= 0.5 || !fallback) ? best : (fallback ?? best ?? null),
      );
    }
    return { ...fields, lineSuggestions };
  }

  private async vendorDefault(
    companyId: string,
    vendorId: string,
    executor: DbExecutor,
  ): Promise<AccountSuggestion | null> {
    const [row] = await executor
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(vendors)
      .innerJoin(accounts, eq(accounts.id, vendors.defaultExpenseAccountId))
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)));
    return row
      ? {
          accountId: row.id,
          accountCode: row.code,
          accountName: row.name,
          taxCodeId: null,
          confidence: 0.5,
          rationale: "vendor's default expense account",
        }
      : null;
  }

  private viewQuery() {
    return this.db
      .select({
        doc: aiDocuments,
        vendorName: vendors.name,
        billNumber: vendorBills.documentNumber,
        claimNumber: expenseClaims.claimNumber,
        createdByName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(aiDocuments)
      .leftJoin(vendors, eq(vendors.id, aiDocuments.vendorId))
      .leftJoin(vendorBills, eq(vendorBills.id, aiDocuments.draftBillId))
      .leftJoin(expenseClaims, eq(expenseClaims.id, aiDocuments.draftExpenseClaimId))
      .leftJoin(users, eq(users.id, aiDocuments.createdBy));
  }

  private toView(row: {
    doc: AiDocument;
    vendorName: string | null;
    billNumber: string | null;
    claimNumber: string | null;
    createdByName: string | null;
  }): AiDocumentView {
    const { sourceText: _text, extracted, ...rest } = row.doc;
    return {
      ...rest,
      extracted: extracted as ExtractedPayload,
      vendorName: row.vendorName,
      draftNumber: row.billNumber ?? row.claimNumber,
      createdByName: row.createdByName,
    };
  }
}
