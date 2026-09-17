import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { Money } from '@accounting/money';
import {
  RECONCILIATION_AREAS,
  type PaginatedResult,
  type ReconciliationArea,
  type SubledgerReconciliationStatus,
} from '@accounting/types';
import type {
  AssignReconciliationInput,
  CreateReconciliationExceptionInput,
  ListReconciliationsQuery,
  ReconciliationNotesInput,
  ResolveReconciliationExceptionInput,
  RunReconciliationInput,
  UpdateAccountingPolicyInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accountingPolicies,
  accounts,
  bankReconciliations,
  reconciliationExceptions,
  reconciliations,
  users,
  type AccountingPolicy,
  type Reconciliation,
  type ReconciliationException,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { BankingService } from '@/modules/banking/banking.service';
import { StatementsService } from '@/modules/banking/statements.service';
import { SubledgerBalancesService, type BalanceLine } from './subledger-balances.service';

const MODULE = 'RECONCILIATION';

export interface ReconciliationView extends Reconciliation {
  controlAccountCode: string;
  controlAccountName: string;
  preparedByName: string | null;
  reviewerName: string | null;
  approvedByName: string | null;
  openExceptions: number;
  /** Signed sum of the exceptions logged so far. */
  explained: string;
}

export interface ReconciliationDetail extends ReconciliationView {
  lines: BalanceLine[];
  exceptions: Array<
    ReconciliationException & { raisedByName: string | null; resolvedByName: string | null }
  >;
  /** Variance not yet covered by an exception. */
  unexplained: string;
}

export interface BankAccountSummary {
  bankAccountId: string;
  code: string;
  name: string;
  currency: string;
  ledgerBalance: string;
  lastStatementDate: string | null;
  /** Latest statement's reconciliation state and what is still unexplained on it. */
  latestStatementId: string | null;
  reconciliationStatus: 'NONE' | 'IN_PROGRESS' | 'COMPLETED';
  unmatched: number;
  possible: number;
  exceptions: number;
}

export interface AreaSummary {
  area: ReconciliationArea;
  /** Latest recorded reconciliation for the area, if any. */
  latest: ReconciliationView | null;
  /** Live figures as of the requested date (what a fresh run would record). */
  live: { expected: string; actual: string; variance: string; withinMateriality: boolean };
  stale: boolean;
}

/**
 * Recorded subledger reconciliations: computation is a snapshot from
 * `SubledgerBalancesService`; the lifecycle is the control - a variance above
 * materiality is never approved until every exception explaining it is
 * resolved and the unexplained remainder is within materiality, and the
 * approver is not the preparer.
 */
@Injectable()
export class ReconciliationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly balances: SubledgerBalancesService,
    private readonly banking: BankingService,
    private readonly statements: StatementsService,
  ) {}

  // ---------------------------------------------------------------- policies

  async policy(companyId: string, executor: DbExecutor = this.db): Promise<AccountingPolicy> {
    const [row] = await executor
      .select()
      .from(accountingPolicies)
      .where(eq(accountingPolicies.companyId, companyId));
    if (row) return row;
    const [created] = await executor
      .insert(accountingPolicies)
      .values({ companyId })
      .onConflictDoNothing()
      .returning();
    return created ?? (await this.policy(companyId, executor));
  }

  async updatePolicy(
    companyId: string,
    actor: AuthenticatedUser,
    input: UpdateAccountingPolicyInput,
  ): Promise<AccountingPolicy> {
    return this.db.transaction(async (tx) => {
      const before = await this.policy(companyId, tx);
      const [after] = await tx
        .update(accountingPolicies)
        .set({
          reconciliationMateriality:
            input.reconciliationMateriality ?? before.reconciliationMateriality,
          reconciliationStaleDays: input.reconciliationStaleDays ?? before.reconciliationStaleDays,
          closeRequireReconciliations:
            input.closeRequireReconciliations ?? before.closeRequireReconciliations,
          closeRequireBankReconciliation:
            input.closeRequireBankReconciliation ?? before.closeRequireBankReconciliation,
          closeRequireDepreciation:
            input.closeRequireDepreciation ?? before.closeRequireDepreciation,
          closeRequireFxRevaluation:
            input.closeRequireFxRevaluation ?? before.closeRequireFxRevaluation,
          closeRequireRevenueRecognition:
            input.closeRequireRevenueRecognition ?? before.closeRequireRevenueRecognition,
          closeBlockOnUnapprovedJournals:
            input.closeBlockOnUnapprovedJournals ?? before.closeBlockOnUnapprovedJournals,
          closeBlockOnOpenExceptions:
            input.closeBlockOnOpenExceptions ?? before.closeBlockOnOpenExceptions,
          closeRequireIntegrityOk: input.closeRequireIntegrityOk ?? before.closeRequireIntegrityOk,
          closeLockOnComplete: input.closeLockOnComplete ?? before.closeLockOnComplete,
          closeBlockOnSuspense: input.closeBlockOnSuspense ?? before.closeBlockOnSuspense,
          suspenseMateriality: input.suspenseMateriality ?? before.suspenseMateriality,
          suspenseMaxAgeDays: input.suspenseMaxAgeDays ?? before.suspenseMaxAgeDays,
        })
        .where(eq(accountingPolicies.companyId, companyId))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'AccountingPolicy',
          entityId: companyId,
          previousValue: { ...before, createdAt: undefined, updatedAt: undefined },
          newValue: { ...after!, createdAt: undefined, updatedAt: undefined },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return after!;
    });
  }

  // ------------------------------------------------------------------ reads

  async list(
    companyId: string,
    query: ListReconciliationsQuery,
  ): Promise<PaginatedResult<ReconciliationView>> {
    const filters: SQL[] = [eq(reconciliations.companyId, companyId)];
    if (query.area) filters.push(eq(reconciliations.area, query.area));
    if (query.status) filters.push(eq(reconciliations.status, query.status));
    if (query.from) filters.push(gte(reconciliations.asOf, query.from));
    if (query.to) filters.push(lte(reconciliations.asOf, query.to));
    const where = and(...filters);
    const [rows, [count]] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(desc(reconciliations.asOf), asc(reconciliations.area))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(reconciliations)
        .where(where),
    ]);
    return toPaginatedResult(rows.map(toView), count?.total ?? 0, query);
  }

  async get(companyId: string, id: string): Promise<ReconciliationDetail> {
    const [row] = await this.viewQuery().where(
      and(eq(reconciliations.id, id), eq(reconciliations.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Reconciliation', id);
    const raisedBy = sql<
      string | null
    >`(select first_name || ' ' || last_name from users u where u.id = ${reconciliationExceptions.raisedBy})`;
    const resolvedBy = sql<
      string | null
    >`(select first_name || ' ' || last_name from users u where u.id = ${reconciliationExceptions.resolvedBy})`;
    const exceptions = await this.db
      .select({ row: reconciliationExceptions, raisedByName: raisedBy, resolvedByName: resolvedBy })
      .from(reconciliationExceptions)
      .where(eq(reconciliationExceptions.reconciliationId, id))
      .orderBy(asc(reconciliationExceptions.createdAt));
    const view = toView(row);
    const currency = await this.balances.currency(companyId);
    const detail = row.row.detail as { lines?: BalanceLine[] };
    return {
      ...view,
      lines: detail.lines ?? [],
      exceptions: exceptions.map((e) => ({
        ...e.row,
        raisedByName: e.raisedByName,
        resolvedByName: e.resolvedByName,
      })),
      unexplained: Money.of(view.variance, currency)
        .subtract(Money.of(view.explained, currency))
        .toString(),
    };
  }

  /** One row per area: latest record plus the live figures - the data behind the reconciliation center. */
  async summary(
    companyId: string,
    asOf: string,
  ): Promise<{
    asOf: string;
    materiality: string;
    areas: AreaSummary[];
    banks: BankAccountSummary[];
  }> {
    const policy = await this.policy(companyId);
    const currency = await this.balances.currency(companyId);
    const materiality = Money.of(policy.reconciliationMateriality, currency);
    const staleBefore = new Date(Date.now() - policy.reconciliationStaleDays * 86_400_000);
    const areas: AreaSummary[] = [];
    for (const area of RECONCILIATION_AREAS) {
      const [latestRow] = await this.viewQuery()
        .where(and(eq(reconciliations.companyId, companyId), eq(reconciliations.area, area)))
        .orderBy(desc(reconciliations.asOf), desc(reconciliations.computedAt))
        .limit(1);
      const latest = latestRow ? toView(latestRow) : null;
      let live: AreaSummary['live'];
      try {
        const b = await this.balances.compute(companyId, area, asOf);
        live = {
          expected: b.expected,
          actual: b.actual,
          variance: b.variance,
          withinMateriality: !Money.of(b.variance, currency).abs().greaterThan(materiality),
        };
      } catch {
        live = { expected: '0', actual: '0', variance: '0', withinMateriality: true };
      }
      areas.push({ area, latest, live, stale: !latest || latest.computedAt < staleBefore });
    }
    const banks = await this.bankSummary(companyId);
    return { asOf, materiality: materiality.toString(), areas, banks };
  }

  /** Bank accounts: ledger balance plus the state of the latest statement's reconciliation. */
  private async bankSummary(companyId: string): Promise<BankAccountSummary[]> {
    const accountsList = await this.banking.listAccounts(companyId);
    const out: BankAccountSummary[] = [];
    for (const a of accountsList) {
      const statements = await this.statements.list(companyId, {
        bankAccountId: a.id,
        page: 1,
        pageSize: 1,
        sortDir: 'desc',
      });
      const latest = statements.items[0];
      let reconciliationStatus: BankAccountSummary['reconciliationStatus'] = 'NONE';
      if (latest) {
        const [rec] = await this.db
          .select({ status: bankReconciliations.status })
          .from(bankReconciliations)
          .where(eq(bankReconciliations.statementId, latest.id));
        reconciliationStatus = rec?.status ?? 'IN_PROGRESS';
      }
      out.push({
        bankAccountId: a.id,
        code: a.code,
        name: a.name,
        currency: a.currency,
        ledgerBalance: a.ledgerBalance,
        lastStatementDate: a.lastStatementDate,
        latestStatementId: latest?.id ?? null,
        reconciliationStatus,
        unmatched: latest?.unmatchedCount ?? 0,
        possible: latest?.possibleCount ?? 0,
        exceptions: latest?.exceptionCount ?? 0,
      });
    }
    return out;
  }

  // --------------------------------------------------------------- commands

  /** Computes (or recomputes) the reconciliation for an area and date; approved records are immutable. */
  async run(
    companyId: string,
    actor: AuthenticatedUser,
    input: RunReconciliationInput,
  ): Promise<ReconciliationDetail> {
    const balance = await this.balances.compute(companyId, input.area, input.asOf);
    const id = await this.db.transaction(async (tx) => {
      const policy = await this.policy(companyId, tx);
      const materiality = Money.of(policy.reconciliationMateriality, balance.currency);
      const variance = Money.of(balance.variance, balance.currency);
      const status: SubledgerReconciliationStatus = variance.abs().greaterThan(materiality)
        ? 'HAS_VARIANCE'
        : 'RECONCILED';
      const [existing] = await tx
        .select()
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.companyId, companyId),
            eq(reconciliations.area, input.area),
            eq(reconciliations.controlAccountId, balance.controlAccountId),
            eq(reconciliations.asOf, input.asOf),
          ),
        )
        .for('update');
      if (existing?.status === 'APPROVED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'An approved reconciliation is final; run a new date instead.',
        );
      const values = {
        status: existing?.status === 'UNDER_REVIEW' ? ('UNDER_REVIEW' as const) : status,
        expectedBalance: balance.expected,
        actualBalance: balance.actual,
        variance: balance.variance,
        materiality: materiality.toString(),
        detail: { ...balance.detail, lines: balance.lines },
        computedAt: new Date(),
        preparedBy: actor.id,
      };
      let rowId: string;
      if (existing) {
        await tx.update(reconciliations).set(values).where(eq(reconciliations.id, existing.id));
        rowId = existing.id;
      } else {
        const [created] = await tx
          .insert(reconciliations)
          .values({
            companyId,
            area: input.area,
            asOf: input.asOf,
            controlAccountId: balance.controlAccountId,
            ...values,
          })
          .returning({ id: reconciliations.id });
        rowId = created!.id;
      }
      await this.audit.record(
        {
          action: existing ? 'UPDATE' : 'CREATE',
          module: MODULE,
          entityType: 'Reconciliation',
          entityId: rowId,
          newValue: {
            area: input.area,
            asOf: input.asOf,
            expected: balance.expected,
            actual: balance.actual,
            variance: balance.variance,
            status: values.status,
          },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return rowId;
    });
    return this.get(companyId, id);
  }

  async assign(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: AssignReconciliationInput,
  ): Promise<ReconciliationDetail> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, companyId, id);
      if (row.status === 'APPROVED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Approved reconciliations cannot be reassigned.',
        );
      const [reviewer] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, input.reviewerId), eq(users.organizationId, actor.organizationId)));
      if (!reviewer) throw new NotFoundError('User', input.reviewerId);
      await tx
        .update(reconciliations)
        .set({
          status: 'UNDER_REVIEW',
          reviewerId: input.reviewerId,
          notes: input.notes ?? row.notes,
        })
        .where(eq(reconciliations.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Reconciliation',
          entityId: id,
          previousValue: { status: row.status },
          newValue: { status: 'UNDER_REVIEW', reviewerId: input.reviewerId },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async addNotes(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: ReconciliationNotesInput,
  ): Promise<ReconciliationDetail> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, companyId, id);
      const stamp = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${actor.firstName} ${actor.lastName}] ${input.notes}`;
      await tx
        .update(reconciliations)
        .set({ notes: row.notes ? `${row.notes}\n${stamp}` : stamp })
        .where(eq(reconciliations.id, id));
    });
    return this.get(companyId, id);
  }

  async addException(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: CreateReconciliationExceptionInput,
  ): Promise<ReconciliationDetail> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, companyId, id);
      if (row.status === 'APPROVED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Approved reconciliations are final.',
        );
      const currency = await this.balances.currency(companyId);
      const [created] = await tx
        .insert(reconciliationExceptions)
        .values({
          reconciliationId: id,
          companyId,
          description: input.description,
          amount: Money.of(input.amount, currency).toString(),
          reference: input.reference ?? null,
          raisedBy: actor.id,
        })
        .returning({ id: reconciliationExceptions.id });
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ReconciliationException',
          entityId: created!.id,
          newValue: { reconciliationId: id, amount: input.amount, description: input.description },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async resolveException(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    exceptionId: string,
    input: ResolveReconciliationExceptionInput,
  ): Promise<ReconciliationDetail> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, companyId, id);
      if (row.status === 'APPROVED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Approved reconciliations are final.',
        );
      const [exc] = await tx
        .select()
        .from(reconciliationExceptions)
        .where(
          and(
            eq(reconciliationExceptions.id, exceptionId),
            eq(reconciliationExceptions.reconciliationId, id),
          ),
        )
        .for('update');
      if (!exc) throw new NotFoundError('Exception', exceptionId);
      if (exc.status === 'RESOLVED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Exception already resolved.',
        );
      await tx
        .update(reconciliationExceptions)
        .set({
          status: 'RESOLVED',
          resolvedBy: actor.id,
          resolvedAt: new Date(),
          resolution: input.resolution,
        })
        .where(eq(reconciliationExceptions.id, exceptionId));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ReconciliationException',
          entityId: exceptionId,
          previousValue: { status: 'OPEN' },
          newValue: { status: 'RESOLVED', resolution: input.resolution },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Approval: four-eyes (not the preparer), and a variance above materiality
   * must be fully explained by resolved exceptions - never silently completed.
   */
  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: { notes?: string },
  ): Promise<ReconciliationDetail> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, companyId, id);
      if (row.status === 'APPROVED')
        throw new BusinessRuleError(ErrorCodes.DOCUMENT_INVALID_STATE, 'Already approved.');
      if (row.preparedBy === actor.id)
        throw new BusinessRuleError(
          ErrorCodes.SOD_VIOLATION,
          'The person who prepared a reconciliation cannot approve it.',
          { preparedBy: row.preparedBy },
        );
      const currency = await this.balances.currency(companyId);
      const exceptions = await tx
        .select()
        .from(reconciliationExceptions)
        .where(eq(reconciliationExceptions.reconciliationId, id));
      const open = exceptions.filter((e) => e.status === 'OPEN');
      if (open.length)
        throw new BusinessRuleError(
          ErrorCodes.RECONCILIATION_UNRESOLVED,
          `${open.length} exception(s) are still open.`,
          { open: open.map((e) => e.id) },
        );
      const variance = Money.of(row.variance, currency);
      const explained = Money.sum(
        exceptions.map((e) => Money.of(e.amount, currency)),
        currency,
      );
      const unexplained = variance.subtract(explained);
      if (unexplained.abs().greaterThan(Money.of(row.materiality, currency)))
        throw new BusinessRuleError(
          ErrorCodes.RECONCILIATION_UNRESOLVED,
          `Unexplained variance ${unexplained.toString()} exceeds the materiality of ${row.materiality}. Log and resolve exceptions that explain it, or correct the books.`,
          {
            variance: row.variance,
            explained: explained.toString(),
            unexplained: unexplained.toString(),
            materiality: row.materiality,
          },
        );
      const stamp = input.notes
        ? `[approved ${new Date().toISOString().slice(0, 10)} ${actor.firstName} ${actor.lastName}] ${input.notes}`
        : null;
      await tx
        .update(reconciliations)
        .set({
          status: 'APPROVED',
          approvedBy: actor.id,
          approvedAt: new Date(),
          reviewedAt: row.reviewedAt ?? new Date(),
          notes: stamp ? (row.notes ? `${row.notes}\n${stamp}` : stamp) : row.notes,
        })
        .where(eq(reconciliations.id, id));
      await this.audit.record(
        {
          action: 'RECONCILIATION_APPROVE',
          module: MODULE,
          entityType: 'Reconciliation',
          entityId: id,
          previousValue: { status: row.status },
          newValue: {
            status: 'APPROVED',
            variance: row.variance,
            explained: explained.toString(),
            unexplained: unexplained.toString(),
          },
          metadata: { actor: actor.email, area: row.area, asOf: row.asOf },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  // ----------------------------------------------------------------- helpers

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<Reconciliation> {
    const [row] = await tx
      .select()
      .from(reconciliations)
      .where(and(eq(reconciliations.id, id), eq(reconciliations.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Reconciliation', id);
    return row;
  }

  private viewQuery() {
    const name = (col: PgColumn) =>
      sql<string | null>`(select first_name || ' ' || last_name from users u where u.id = ${col})`;
    return this.db
      .select({
        row: reconciliations,
        controlAccountCode: accounts.code,
        controlAccountName: accounts.name,
        preparedByName: name(reconciliations.preparedBy),
        reviewerName: name(reconciliations.reviewerId),
        approvedByName: name(reconciliations.approvedBy),
        openExceptions: sql<number>`(select count(*)::int from reconciliation_exceptions x where x.reconciliation_id = ${reconciliations.id} and x.status = 'OPEN')`,
        explained: sql<string>`(select coalesce(sum(x.amount), 0)::text from reconciliation_exceptions x where x.reconciliation_id = ${reconciliations.id})`,
      })
      .from(reconciliations)
      .innerJoin(accounts, eq(accounts.id, reconciliations.controlAccountId));
  }
}

type ViewRow = {
  row: Reconciliation;
  controlAccountCode: string;
  controlAccountName: string;
  preparedByName: string | null;
  reviewerName: string | null;
  approvedByName: string | null;
  openExceptions: number;
  explained: string;
};

function toView(r: ViewRow): ReconciliationView {
  const { detail, ...rest } = r.row;
  return {
    ...rest,
    detail: { ...(detail as Record<string, unknown>), lines: undefined },
    controlAccountCode: r.controlAccountCode,
    controlAccountName: r.controlAccountName,
    preparedByName: r.preparedByName,
    reviewerName: r.reviewerName,
    approvedByName: r.approvedByName,
    openExceptions: r.openExceptions,
    explained: r.explained,
  };
}
