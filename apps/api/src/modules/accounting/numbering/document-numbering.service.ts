import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DEFAULT_NUMBERING_FORMAT, DOCUMENT_TYPES, type DocumentType } from '@accounting/types';
import type { NumberingRuleInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { branches, documentSequences, numberingRules, type NumberingRule } from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';

const DEFAULT_PREFIX: Record<DocumentType, string> = {
  JE: 'JE',
  INV: 'INV',
  CN: 'CN',
  DN: 'DN',
  RCP: 'RCP',
  BILL: 'BILL',
  VCN: 'VCN',
  VDN: 'VDN',
  PAY: 'PAY',
  QT: 'QT',
  SO: 'SO',
  PR: 'PR',
  PO: 'PO',
  GR: 'GR',
  SRN: 'SRN',
  PRN: 'PRN',
  ADJ: 'ADJ',
  TRF: 'TRF',
  CNT: 'CNT',
  FA: 'FA',
  DEP: 'DEP',
  BTX: 'BTX',
  STM: 'STM',
  EXP: 'EXP',
  ICT: 'ICT',
  FXR: 'FXR',
  DLV: 'DLV',
  WO: 'WO',
  COL: 'COL',
  DSP: 'DSP',
  RFD: 'RFD',
  PRV: 'PRV',
  STMT: 'STMT',
  PMR: 'PMR',
  ACR: 'ACR',
  BTR: 'BTR',
  PCV: 'PCV',
  PMF: 'PMF',
  CON: 'CON',
  RRN: 'RRN',
};

/** The rule that governs a document number, whether configured or the built-in default. */
export interface EffectiveRule {
  documentType: DocumentType;
  branchId: string | null;
  prefix: string;
  format: string;
  padding: number;
  resetYearly: boolean;
  /** Configured rule id, or null for the built-in default. */
  ruleId: string | null;
}

export interface NumberingRuleView extends EffectiveRule {
  branchCode: string | null;
  branchName: string | null;
  isActive: boolean;
  /** The number the next document would receive this year. */
  nextNumber: string;
}

export interface AllocateOptions {
  /** Branch of the document; picks a branch-specific rule and counter when one exists. */
  branchId?: string | null;
}

/**
 * Document numbering engine. Numbers are `format` templates over a per
 * (company, type, year, branch) counter: `{PREFIX}-{BRANCH}-{YEAR}-{SEQ}`.
 * Allocation is a single atomic upsert inside the caller's transaction, so two
 * concurrent documents never share a number and a rolled-back document rolls
 * its number back with it - numbers are never reused and never handed out
 * twice. Rules are data (`numbering_rules`); the built-in default is
 * `<PREFIX>-<YEAR>-<NNNNNN>`.
 */
@Injectable()
export class DocumentNumberingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async allocate(
    companyId: string,
    documentType: DocumentType,
    year: number,
    executor: DbExecutor = this.db,
    options: AllocateOptions = {},
  ): Promise<string> {
    const rule = await this.effectiveRule(companyId, documentType, options.branchId, executor);
    const counterYear = rule.resetYearly ? year : 0;
    const [row] = await executor
      .insert(documentSequences)
      .values({
        companyId,
        documentType,
        branchId: rule.branchId,
        year: counterYear,
        prefix: rule.prefix,
        padding: rule.padding,
        nextNumber: 2,
      })
      .onConflictDoUpdate({
        target: [
          documentSequences.companyId,
          documentSequences.documentType,
          documentSequences.year,
          documentSequences.branchId,
        ],
        set: { nextNumber: sql`${documentSequences.nextNumber} + 1`, updatedAt: new Date() },
      })
      .returning({ nextNumber: documentSequences.nextNumber });
    if (!row) throw new Error('Sequence allocation returned no row');
    // The row now holds the NEXT number; the allocated one is next - 1.
    return this.format(
      rule,
      row.nextNumber - 1,
      year,
      await this.branchCode(rule.branchId, executor),
    );
  }

  /** The number the next document would receive, without consuming it. */
  async preview(
    companyId: string,
    documentType: DocumentType,
    branchId: string | null | undefined,
    year: number,
    executor: DbExecutor = this.db,
  ): Promise<string> {
    const rule = await this.effectiveRule(companyId, documentType, branchId, executor);
    const counterYear = rule.resetYearly ? year : 0;
    const [row] = await executor
      .select({ nextNumber: documentSequences.nextNumber })
      .from(documentSequences)
      .where(
        and(
          eq(documentSequences.companyId, companyId),
          eq(documentSequences.documentType, documentType),
          eq(documentSequences.year, counterYear),
          rule.branchId
            ? eq(documentSequences.branchId, rule.branchId)
            : isNull(documentSequences.branchId),
        ),
      );
    return this.format(
      rule,
      row?.nextNumber ?? 1,
      year,
      await this.branchCode(rule.branchId, executor),
    );
  }

  /** Every document type with its effective company rule plus configured branch overrides. */
  async list(companyId: string, year: number): Promise<NumberingRuleView[]> {
    const rules = await this.db
      .select({
        rule: numberingRules,
        branchCode: branches.code,
        branchName: branches.name,
      })
      .from(numberingRules)
      .leftJoin(branches, eq(branches.id, numberingRules.branchId))
      .where(eq(numberingRules.companyId, companyId))
      .orderBy(asc(numberingRules.documentType), asc(branches.code));
    const views: NumberingRuleView[] = [];
    for (const type of DOCUMENT_TYPES) {
      const company = rules.find((r) => r.rule.documentType === type && r.rule.branchId === null);
      const effective = company ? toEffective(company.rule) : defaultRule(type);
      views.push({
        ...effective,
        branchCode: null,
        branchName: null,
        isActive: company?.rule.isActive ?? true,
        nextNumber: await this.preview(companyId, type, null, year),
      });
      for (const r of rules.filter(
        (x) => x.rule.documentType === type && x.rule.branchId !== null,
      )) {
        views.push({
          ...toEffective(r.rule),
          branchCode: r.branchCode,
          branchName: r.branchName,
          isActive: r.rule.isActive,
          nextNumber: await this.preview(companyId, type, r.rule.branchId, year),
        });
      }
    }
    return views;
  }

  /** Creates or replaces the rule for (type, branch). Counters already issued are never reset. */
  async upsert(
    companyId: string,
    actor: AuthenticatedUser,
    input: NumberingRuleInput,
  ): Promise<NumberingRule> {
    validateFormat(input.format);
    return this.db.transaction(async (tx) => {
      if (input.branchId) {
        const [branch] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.id, input.branchId), eq(branches.companyId, companyId)));
        if (!branch) throw new NotFoundError('Branch', input.branchId);
      }
      const [existing] = await tx
        .select()
        .from(numberingRules)
        .where(
          and(
            eq(numberingRules.companyId, companyId),
            eq(numberingRules.documentType, input.documentType),
            input.branchId
              ? eq(numberingRules.branchId, input.branchId)
              : isNull(numberingRules.branchId),
          ),
        );
      const values = {
        prefix: input.prefix,
        format: input.format,
        padding: input.padding,
        resetYearly: input.resetYearly,
        isActive: input.isActive,
      };
      const [row] = existing
        ? await tx
            .update(numberingRules)
            .set(values)
            .where(eq(numberingRules.id, existing.id))
            .returning()
        : await tx
            .insert(numberingRules)
            .values({
              companyId,
              documentType: input.documentType,
              branchId: input.branchId ?? null,
              ...values,
            })
            .returning();
      await this.audit.record(
        {
          action: existing ? 'UPDATE' : 'CREATE',
          module: 'ACCOUNTING',
          entityType: 'NumberingRule',
          entityId: row!.id,
          previousValue: existing
            ? {
                prefix: existing.prefix,
                format: existing.format,
                padding: existing.padding,
                resetYearly: existing.resetYearly,
                isActive: existing.isActive,
              }
            : undefined,
          newValue: {
            documentType: input.documentType,
            branchId: input.branchId ?? null,
            ...values,
          },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  /** Removes a configured rule; documents fall back to the company rule or the default. */
  async remove(companyId: string, actor: AuthenticatedUser, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(numberingRules)
        .where(and(eq(numberingRules.id, id), eq(numberingRules.companyId, companyId)));
      if (!existing) throw new NotFoundError('Numbering rule', id);
      await tx.delete(numberingRules).where(eq(numberingRules.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: 'ACCOUNTING',
          entityType: 'NumberingRule',
          entityId: id,
          previousValue: { documentType: existing.documentType, branchId: existing.branchId },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
  }

  // ----------------------------------------------------------------- helpers

  /** Branch rule when the document has a branch and one is configured, else company rule, else default. */
  private async effectiveRule(
    companyId: string,
    documentType: DocumentType,
    branchId: string | null | undefined,
    executor: DbExecutor,
  ): Promise<EffectiveRule> {
    const rows = await executor
      .select()
      .from(numberingRules)
      .where(
        and(
          eq(numberingRules.companyId, companyId),
          eq(numberingRules.documentType, documentType),
          eq(numberingRules.isActive, true),
        ),
      );
    const branchRule = branchId ? rows.find((r) => r.branchId === branchId) : undefined;
    const companyRule = rows.find((r) => r.branchId === null);
    const rule = branchRule ?? companyRule;
    return rule ? toEffective(rule) : defaultRule(documentType);
  }

  private async branchCode(branchId: string | null, executor: DbExecutor): Promise<string | null> {
    if (!branchId) return null;
    const [row] = await executor
      .select({ code: branches.code })
      .from(branches)
      .where(eq(branches.id, branchId));
    return row?.code ?? null;
  }

  private format(rule: EffectiveRule, sequence: number, year: number, branchCode: string | null) {
    return formatNumber(rule.format, {
      prefix: rule.prefix,
      branch: branchCode ?? '',
      year,
      sequence,
      padding: rule.padding,
    });
  }
}

function toEffective(rule: NumberingRule): EffectiveRule {
  return {
    documentType: rule.documentType,
    branchId: rule.branchId,
    prefix: rule.prefix,
    format: rule.format,
    padding: rule.padding,
    resetYearly: rule.resetYearly,
    ruleId: rule.id,
  };
}

function defaultRule(documentType: DocumentType): EffectiveRule {
  return {
    documentType,
    branchId: null,
    prefix: DEFAULT_PREFIX[documentType],
    format: DEFAULT_NUMBERING_FORMAT,
    padding: 6,
    resetYearly: true,
    ruleId: null,
  };
}

function validateFormat(format: string): void {
  if (!format.includes('{SEQ}'))
    throw new BusinessRuleError(
      ErrorCodes.VALIDATION_FAILED,
      'A numbering format must contain {SEQ}.',
    );
}

/** Pure: renders a document number from a format template. */
export function formatNumber(
  format: string,
  parts: { prefix: string; branch: string; year: number; sequence: number; padding: number },
): string {
  const rendered = format
    .replaceAll('{PREFIX}', parts.prefix)
    .replaceAll('{BRANCH}', parts.branch)
    .replaceAll('{YEAR}', String(parts.year))
    .replaceAll('{YY}', String(parts.year).slice(-2))
    .replaceAll('{SEQ}', String(parts.sequence).padStart(parts.padding, '0'));
  // A branch token without a branch would leave a double separator.
  return rendered.replace(/--+/g, '-').replace(/^-|-$/g, '');
}
