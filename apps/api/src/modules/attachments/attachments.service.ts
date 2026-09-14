import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  ATTACHMENT_ALLOWED_MIME,
  ATTACHMENT_MAX_BYTES,
  type AttachmentEntityType,
} from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  aiDocuments,
  reconciliations,
  attachments,
  bankStatements,
  customerPayments,
  customers,
  expenseClaims,
  fixedAssets,
  invoices,
  journalEntries,
  orders,
  vendorBills,
  vendorPayments,
  vendors,
  type Attachment,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'ATTACHMENTS';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface AttachmentView extends Attachment {
  uploadedByName: string | null;
}

/**
 * Files attached to documents. Bytes live on disk under `STORAGE_DIR` keyed
 * by company / entity; the row carries the checksum so a download can be
 * verified. Never served from a user-controlled path.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  async list(
    companyId: string,
    entityType: AttachmentEntityType,
    entityId: string,
  ): Promise<AttachmentView[]> {
    await this.assertEntity(this.db, companyId, entityType, entityId);
    const rows = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.companyId, companyId),
          eq(attachments.entityType, entityType),
          eq(attachments.entityId, entityId),
        ),
      )
      .orderBy(desc(attachments.createdAt));
    return this.withNames(rows);
  }

  async upload(
    companyId: string,
    actor: AuthenticatedUser,
    entityType: AttachmentEntityType,
    entityId: string,
    file: UploadedFile,
    description?: string,
  ): Promise<AttachmentView> {
    if (!file || !file.buffer?.length)
      throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'No file was uploaded.');
    if (file.size > ATTACHMENT_MAX_BYTES)
      throw new BusinessRuleError(
        ErrorCodes.FILE_NOT_ALLOWED,
        `Files are limited to ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB.`,
      );
    if (!(ATTACHMENT_ALLOWED_MIME as readonly string[]).includes(file.mimetype))
      throw new BusinessRuleError(
        ErrorCodes.FILE_NOT_ALLOWED,
        `${file.mimetype} files are not accepted.`,
        { allowed: ATTACHMENT_ALLOWED_MIME },
      );
    const fileName = sanitizeName(file.originalname);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const storageKey = join(
      companyId,
      entityType.toLowerCase(),
      entityId,
      `${randomUUID()}${extname(fileName).toLowerCase()}`,
    ).replace(/\\/g, '/');
    const id = await this.db.transaction(async (tx) => {
      await this.assertEntity(tx, companyId, entityType, entityId);
      const absolute = this.absolutePath(storageKey);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.buffer);
      const [row] = await tx
        .insert(attachments)
        .values({
          companyId,
          entityType,
          entityId,
          fileName,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          sha256,
          storageKey,
          description: description ?? null,
          uploadedBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Attachment',
          entityId: row!.id,
          newValue: { entityType, entityId, fileName, sizeBytes: file.size, sha256 },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!.id;
    });
    const [row] = await this.db.select().from(attachments).where(eq(attachments.id, id));
    return (await this.withNames([row!]))[0]!;
  }

  async get(companyId: string, id: string): Promise<Attachment> {
    const [row] = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.companyId, companyId)));
    if (!row) throw new NotFoundError('Attachment', id);
    return row;
  }

  /** Readable stream of the stored bytes plus the metadata needed for the response headers. */
  async open(
    companyId: string,
    id: string,
  ): Promise<{ row: Attachment; stream: NodeJS.ReadableStream }> {
    const row = await this.get(companyId, id);
    return { row, stream: createReadStream(this.absolutePath(row.storageKey)) };
  }

  async remove(companyId: string, actor: AuthenticatedUser, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(attachments)
        .where(and(eq(attachments.id, id), eq(attachments.companyId, companyId)))
        .for('update');
      if (!row) throw new NotFoundError('Attachment', id);
      await tx.delete(attachments).where(eq(attachments.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Attachment',
          entityId: id,
          previousValue: {
            entityType: row.entityType,
            entityId: row.entityId,
            fileName: row.fileName,
          },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      await unlink(this.absolutePath(row.storageKey)).catch(() => undefined);
    });
  }

  /**
   * Moves a file to another entity inside the caller's transaction - used when
   * an AI-intake document becomes a draft bill or claim so the source travels with it.
   */
  async relink(
    tx: DbExecutor,
    companyId: string,
    id: string,
    entityType: AttachmentEntityType,
    entityId: string,
  ): Promise<void> {
    await this.assertEntity(tx, companyId, entityType, entityId);
    await tx
      .update(attachments)
      .set({ entityType, entityId })
      .where(and(eq(attachments.id, id), eq(attachments.companyId, companyId)));
  }

  // ----------------------------------------------------------------- helpers

  private absolutePath(storageKey: string): string {
    const root = resolve(this.config.env.STORAGE_DIR);
    const full = resolve(root, storageKey);
    if (!full.startsWith(root))
      throw new BusinessRuleError(ErrorCodes.FILE_NOT_ALLOWED, 'Invalid storage key.');
    return full;
  }

  /** The target must exist in the caller's company. */
  private async assertEntity(
    executor: DbExecutor,
    companyId: string,
    entityType: AttachmentEntityType,
    entityId: string,
  ): Promise<void> {
    const table = {
      JOURNAL_ENTRY: journalEntries,
      INVOICE: invoices,
      BILL: vendorBills,
      CUSTOMER_PAYMENT: customerPayments,
      VENDOR_PAYMENT: vendorPayments,
      EXPENSE_CLAIM: expenseClaims,
      FIXED_ASSET: fixedAssets,
      BANK_STATEMENT: bankStatements,
      ORDER: orders,
      CUSTOMER: customers,
      VENDOR: vendors,
      AI_DOCUMENT: aiDocuments,
      RECONCILIATION: reconciliations,
    }[entityType];
    const [row] = await executor
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, entityId), eq(table.companyId, companyId)));
    if (!row) throw new NotFoundError(entityType.toLowerCase().replace('_', ' '), entityId);
  }

  private async withNames(rows: Attachment[]): Promise<AttachmentView[]> {
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((r) => r.uploadedBy).filter((x): x is string => Boolean(x)))];
    const users = ids.length
      ? await this.db.query.users.findMany({
          where: (u, ops) => ops.inArray(u.id, ids),
          columns: { id: true, firstName: true, lastName: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
    return rows.map((r) => ({
      ...r,
      uploadedByName: r.uploadedBy ? (names.get(r.uploadedBy) ?? null) : null,
    }));
  }
}

function sanitizeName(name: string): string {
  const base = name
    .replace(/[\\/]+/g, '_')
    .replace(/[^\w.\- ()]+/g, '_')
    .trim();
  return (base || 'file').slice(0, 200);
}
