import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  importStatementSchema,
  isoDateSchema,
  statementLineInputSchema,
} from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import { StatementsService } from '@/modules/banking/statements.service';
import type { ExternalRecord } from '../../core/connector';
import { IntegrationError } from '../../core/integration-error';
import { ExternalReferencesService } from '../../mapping/external-references.service';
import { mappingError } from './customers.importer';
import {
  assertScope,
  domainIdempotencyKey,
  type ImportContext,
  type ImportOutcome,
  type Importer,
} from './importer';

const ENTITY = 'bank-transactions';

/** A bank feed delivers statements (a balanced set of lines), never loose amounts. */
export const externalStatementSchema = z.object({
  statementDate: isoDateSchema,
  openingBalance: z.string(),
  closingBalance: z.string(),
  lines: z.array(statementLineInputSchema).min(1),
});

/**
 * Bank feed -> StatementsService.import. The lines become statement lines to
 * be matched against ledger entries in the banking module; nothing here posts,
 * because a statement is evidence, not a transaction. Reconciliation turns a
 * confirmed match into a business transaction, which posts on its own path.
 */
@Injectable()
export class BankTransactionsImporter implements Importer {
  readonly entity = ENTITY;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly statements: StatementsService,
    private readonly refs: ExternalReferencesService,
  ) {}

  async import(
    ctx: ImportContext,
    record: ExternalRecord,
    mapped: Record<string, unknown>,
  ): Promise<ImportOutcome> {
    const existing = await this.refs.findByExternal(ctx.integration.id, ENTITY, record.externalId);
    if (existing)
      return {
        action: 'SKIPPED',
        internalId: existing.internalId,
        message: 'statement already imported',
      };
    assertScope(ctx, 'bank-statement.import');
    const bankAccountId = ctx.integration.config.bankAccountId;
    if (typeof bankAccountId !== 'string')
      throw new IntegrationError(
        'VALIDATION_ERROR',
        'The integration has no bankAccountId configured.',
      );
    const parsed = externalStatementSchema.safeParse(mapped);
    if (!parsed.success) throw mappingError(parsed.error.issues);
    const input = importStatementSchema.safeParse({
      bankAccountId,
      ...parsed.data,
      fileName: `${ctx.provider}:${record.externalId}`,
      idempotencyKey: domainIdempotencyKey(ctx, ENTITY, record.externalId),
    });
    if (!input.success) throw mappingError(input.error.issues);
    const view = await this.statements.import(ctx.companyId, ctx.principal, input.data);
    await this.db.transaction((tx) =>
      this.refs.link(tx, {
        integrationId: ctx.integration.id,
        provider: ctx.provider,
        entityType: ENTITY,
        externalId: record.externalId,
        internalId: view.id,
        metadata: { lines: view.lineCount },
      }),
    );
    return {
      action: 'CREATED',
      internalId: view.id,
      message: `${view.lineCount} lines, ${view.matchedCount} auto-matched`,
    };
  }
}
