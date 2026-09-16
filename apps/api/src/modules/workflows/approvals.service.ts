import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type {
  ApprovalRequestStatus,
  PaginatedResult,
  PermissionKey,
  WorkflowDocumentType,
} from '@accounting/types';
import type {
  CreateWorkflowInput,
  DecideApprovalInput,
  ListApprovalsQuery,
  UpdateWorkflowInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  approvalDecisions,
  approvalRequests,
  approvalWorkflows,
  users,
  type ApprovalRequest,
  type ApprovalWorkflow,
  type WorkflowStep,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { PermissionResolverService } from '@/modules/rbac/permission-resolver.service';
import { AuthorityService } from '@/modules/delegations/authority.service';

const MODULE = 'WORKFLOWS';

export interface ApprovalRequestView extends ApprovalRequest {
  workflowName: string;
  requestedByName: string | null;
  /** Approvals still needed on the current step. */
  pendingApprovals: number;
  /** Whether the acting user can decide the current step right now. */
  canDecide: boolean;
  /** Pending past its deadline. */
  overdue: boolean;
  /** Permission that may decide the request while it is overdue (from the workflow). */
  escalationPermission: string | null;
}

export interface ApprovalRequestDetail extends ApprovalRequestView {
  decisions: Array<{
    id: string;
    step: number;
    decision: 'APPROVE' | 'REJECT';
    comment: string | null;
    decidedBy: string;
    decidedByName: string | null;
    decidedAt: Date;
  }>;
}

export interface DocumentRef {
  companyId: string;
  documentType: WorkflowDocumentType;
  documentId: string;
  documentNumber: string;
  amount: string;
  currency: string;
  requestedBy: string;
  /** Branch of the document, for branch-specific workflows. */
  branchId?: string | null;
}

/**
 * Configurable approval chains. A document module calls `assertApproved`
 * at its approve / post step: with no matching workflow it passes; otherwise a
 * PENDING request is opened (or found) and APPROVAL_REQUIRED is raised until
 * every step has enough distinct approvers. Requests snapshot the workflow's
 * steps so later edits never change an open chain.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly resolver: PermissionResolverService,
    private readonly authority: AuthorityService,
  ) {}

  // --------------------------------------------------------------- workflows

  async listWorkflows(
    companyId: string,
  ): Promise<Array<ApprovalWorkflow & { openRequests: number }>> {
    return this.db
      .select({
        ...getTableColumns(approvalWorkflows),
        openRequests: sql<number>`(select count(*)::int from approval_requests r where r.workflow_id = ${sql.raw('"approval_workflows"."id"')} and r.status = 'PENDING')`,
      })
      .from(approvalWorkflows)
      .where(eq(approvalWorkflows.companyId, companyId))
      .orderBy(
        asc(approvalWorkflows.documentType),
        asc(approvalWorkflows.priority),
        asc(approvalWorkflows.minAmount),
      );
  }

  async createWorkflow(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateWorkflowInput,
  ): Promise<ApprovalWorkflow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(approvalWorkflows)
        .values({
          companyId,
          documentType: input.documentType,
          name: input.name,
          description: input.description ?? null,
          minAmount: input.minAmount,
          maxAmount: input.maxAmount ?? null,
          priority: input.priority,
          allowSelfApproval: input.allowSelfApproval,
          branchId: input.branchId ?? null,
          deadlineHours: input.deadlineHours ?? null,
          escalationPermission: input.escalationPermission ?? null,
          steps: input.steps,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ApprovalWorkflow',
          entityId: row!.id,
          newValue: {
            name: input.name,
            documentType: input.documentType,
            steps: input.steps.length,
          },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async updateWorkflow(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateWorkflowInput,
  ): Promise<ApprovalWorkflow> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(approvalWorkflows)
        .where(and(eq(approvalWorkflows.id, id), eq(approvalWorkflows.companyId, companyId)))
        .for('update');
      if (!existing) throw new NotFoundError('Approval workflow', id);
      const minAmount = input.minAmount ?? existing.minAmount;
      const maxAmount = input.maxAmount === undefined ? existing.maxAmount : input.maxAmount;
      if (maxAmount !== null && Number(maxAmount) <= Number(minAmount))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Max amount must exceed min amount.',
        );
      const [row] = await tx
        .update(approvalWorkflows)
        .set({
          name: input.name ?? existing.name,
          description: input.description === undefined ? existing.description : input.description,
          minAmount,
          maxAmount,
          priority: input.priority ?? existing.priority,
          allowSelfApproval: input.allowSelfApproval ?? existing.allowSelfApproval,
          branchId: input.branchId === undefined ? existing.branchId : input.branchId,
          deadlineHours:
            input.deadlineHours === undefined ? existing.deadlineHours : input.deadlineHours,
          escalationPermission:
            input.escalationPermission === undefined
              ? existing.escalationPermission
              : input.escalationPermission,
          steps: input.steps ?? existing.steps,
          status: input.status ?? existing.status,
        })
        .where(eq(approvalWorkflows.id, id))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ApprovalWorkflow',
          entityId: id,
          previousValue: { name: existing.name, status: existing.status },
          newValue: input,
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  /**
   * The active workflow governing a document: amount band match, lowest
   * priority number wins; a workflow scoped to the document's branch beats a
   * company-wide one of equal priority.
   */
  async match(
    tx: DbExecutor,
    companyId: string,
    documentType: WorkflowDocumentType,
    amount: string,
    branchId?: string | null,
  ): Promise<ApprovalWorkflow | null> {
    const rows = await tx
      .select()
      .from(approvalWorkflows)
      .where(
        and(
          eq(approvalWorkflows.companyId, companyId),
          eq(approvalWorkflows.documentType, documentType),
          eq(approvalWorkflows.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(approvalWorkflows.priority), asc(approvalWorkflows.minAmount));
    const value = Number(amount);
    const candidates = rows.filter(
      (w) =>
        value >= Number(w.minAmount) &&
        (w.maxAmount === null || value < Number(w.maxAmount)) &&
        (w.branchId === null || w.branchId === (branchId ?? null)),
    );
    return (
      candidates.sort((a, b) =>
        a.priority !== b.priority
          ? a.priority - b.priority
          : Number(b.branchId !== null) - Number(a.branchId !== null),
      )[0] ?? null
    );
  }

  // ---------------------------------------------------------------- requests

  /** Opens a request when a workflow applies and none is pending. Returns the open request or null. */
  async open(tx: DbExecutor, doc: DocumentRef): Promise<ApprovalRequest | null> {
    const workflow = await this.match(
      tx,
      doc.companyId,
      doc.documentType,
      doc.amount,
      doc.branchId,
    );
    if (!workflow) return null;
    const [pending] = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.documentType, doc.documentType),
          eq(approvalRequests.documentId, doc.documentId),
          eq(approvalRequests.status, 'PENDING'),
        ),
      );
    if (pending) return pending;
    const [row] = await tx
      .insert(approvalRequests)
      .values({
        companyId: doc.companyId,
        workflowId: workflow.id,
        documentType: doc.documentType,
        documentId: doc.documentId,
        documentNumber: doc.documentNumber,
        amount: doc.amount,
        currency: doc.currency,
        steps: workflow.steps,
        requestedBy: doc.requestedBy,
        branchId: doc.branchId ?? null,
        dueAt: workflow.deadlineHours
          ? new Date(Date.now() + workflow.deadlineHours * 3_600_000)
          : null,
      })
      .returning();
    await this.audit.record(
      {
        action: 'SUBMIT',
        module: MODULE,
        entityType: 'ApprovalRequest',
        entityId: row!.id,
        newValue: {
          documentType: doc.documentType,
          documentNumber: doc.documentNumber,
          workflow: workflow.name,
          amount: doc.amount,
        },
        companyId: doc.companyId,
      },
      tx,
    );
    return row!;
  }

  /**
   * Gate for a document's approve / post step. Passes when no workflow applies
   * or the latest request is APPROVED; otherwise opens / keeps the request and
   * raises APPROVAL_REQUIRED with its id.
   */
  async assertApproved(tx: DbExecutor, doc: DocumentRef): Promise<void> {
    const workflow = await this.match(
      tx,
      doc.companyId,
      doc.documentType,
      doc.amount,
      doc.branchId,
    );
    if (!workflow) return;
    const [latest] = await tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.documentType, doc.documentType),
          eq(approvalRequests.documentId, doc.documentId),
        ),
      )
      .orderBy(desc(approvalRequests.createdAt))
      .limit(1);
    if (
      latest?.status === 'APPROVED' &&
      Money.of(latest.amount, doc.currency).equals(Money.of(doc.amount, doc.currency))
    )
      return;
    // The caller's transaction is about to roll back with APPROVAL_REQUIRED, so the
    // request is opened on its own connection - otherwise it would vanish with it.
    const request = latest?.status === 'PENDING' ? latest : await this.open(this.db, doc);
    throw new BusinessRuleError(
      ErrorCodes.APPROVAL_REQUIRED,
      `${doc.documentNumber} needs approval through "${workflow.name}" (step ${(request?.currentStep ?? 0) + 1} of ${workflow.steps.length}).`,
      {
        requestId: request?.id ?? null,
        workflowId: workflow.id,
        status: request?.status ?? 'PENDING',
      },
    );
  }

  /** Cancels any open request when its document is voided, cancelled or rejected. */
  async cancelFor(
    tx: DbExecutor,
    documentType: WorkflowDocumentType,
    documentId: string,
  ): Promise<void> {
    await tx
      .update(approvalRequests)
      .set({ status: 'CANCELLED', completedAt: new Date() })
      .where(
        and(
          eq(approvalRequests.documentType, documentType),
          eq(approvalRequests.documentId, documentId),
          eq(approvalRequests.status, 'PENDING'),
        ),
      );
  }

  async list(
    companyId: string,
    actor: AuthenticatedUser,
    query: ListApprovalsQuery,
  ): Promise<PaginatedResult<ApprovalRequestView>> {
    await this.escalateOverdue(companyId);
    const filters: SQL[] = [eq(approvalRequests.companyId, companyId)];
    if (query.status) filters.push(eq(approvalRequests.status, query.status));
    if (query.documentType) filters.push(eq(approvalRequests.documentType, query.documentType));
    if (query.mine) filters.push(eq(approvalRequests.status, 'PENDING'));
    if (query.overdue)
      filters.push(eq(approvalRequests.status, 'PENDING'), sql`${approvalRequests.dueAt} < now()`);
    if (query.search)
      filters.push(sql`${approvalRequests.documentNumber} ilike ${`%${query.search}%`}`);
    const where = and(...filters);
    const access = await this.resolver.resolve(actor.id, companyId);
    const rows = await this.viewQuery(this.db)
      .where(where)
      .orderBy(desc(approvalRequests.createdAt))
      .limit(query.mine ? 500 : query.pageSize)
      .offset(query.mine ? 0 : offsetFor(query));
    const decided = rows.length
      ? await this.db
          .select({
            requestId: approvalDecisions.requestId,
            step: approvalDecisions.step,
            decidedBy: approvalDecisions.decidedBy,
          })
          .from(approvalDecisions)
          .where(
            inArray(
              approvalDecisions.requestId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    const enriched = rows.map((r) =>
      this.enrich(
        r,
        decided.filter((d) => d.requestId === r.id),
        actor.id,
        access.permissions,
        actor.delegations,
      ),
    );
    if (query.mine) {
      const mine = enriched.filter((r) => r.canDecide);
      return toPaginatedResult(
        mine.slice(offsetFor(query), offsetFor(query) + query.pageSize),
        mine.length,
        query,
      );
    }
    const [count] = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(approvalRequests)
      .where(where);
    return toPaginatedResult(enriched, Number(count?.total ?? 0), query);
  }

  async get(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<ApprovalRequestDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(approvalRequests.id, id), eq(approvalRequests.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Approval request', id);
    const decisions = await this.db
      .select({
        id: approvalDecisions.id,
        step: approvalDecisions.step,
        decision: approvalDecisions.decision,
        comment: approvalDecisions.comment,
        decidedBy: approvalDecisions.decidedBy,
        decidedByName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
        decidedAt: approvalDecisions.decidedAt,
      })
      .from(approvalDecisions)
      .leftJoin(users, eq(users.id, approvalDecisions.decidedBy))
      .where(eq(approvalDecisions.requestId, id))
      .orderBy(asc(approvalDecisions.decidedAt));
    const access = await this.resolver.resolve(actor.id, companyId);
    return {
      ...this.enrich(row, decisions, actor.id, access.permissions, actor.delegations),
      decisions,
    };
  }

  /** One decision per approver per step; the step completes at `minApprovers`; a rejection ends the request. */
  async decide(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: DecideApprovalInput,
  ): Promise<ApprovalRequestDetail> {
    await this.db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.id, id), eq(approvalRequests.companyId, companyId)))
        .for('update');
      if (!request) throw new NotFoundError('Approval request', id);
      if (request.status !== 'PENDING')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `Request is ${request.status.toLowerCase()}.`,
        );
      const [workflow] = await tx
        .select()
        .from(approvalWorkflows)
        .where(eq(approvalWorkflows.id, request.workflowId));
      const step = request.steps[request.currentStep];
      if (!step)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'The request has no open step.',
        );
      const access = await this.resolver.resolve(actor.id, companyId, tx);
      const overdue = request.dueAt !== null && request.dueAt.getTime() < Date.now();
      const escalated =
        overdue &&
        workflow?.escalationPermission !== null &&
        workflow?.escalationPermission !== undefined &&
        access.permissions.has(workflow.escalationPermission);
      // The step's permission may be held natively, exercised through escalation
      // once the request is overdue, or lent by an active delegation (scope,
      // amount ceiling and SoD are enforced and the use is recorded).
      let delegatedAudit: Record<string, unknown> | undefined;
      if (!access.permissions.has(step.requiredPermission) && !escalated) {
        const grants = actor.delegations ?? [];
        if (!grants.some((g) => g.permission === step.requiredPermission))
          throw new BusinessRuleError(
            ErrorCodes.APPROVAL_NOT_ELIGIBLE,
            `Step "${step.name}" needs the ${step.requiredPermission} permission.`,
          );
        const authority = await this.authority.assert(
          tx,
          { ...actor, permissions: access.permissions },
          step.requiredPermission as PermissionKey,
          {
            companyId,
            amount: request.amount,
            currency: request.currency,
            documentType: 'APPROVAL_REQUEST',
            documentId: id,
            documentNumber: request.documentNumber,
            createdBy: request.requestedBy,
            action: `${input.decision === 'APPROVE' ? 'Approved' : 'Rejected'} workflow step "${step.name}" for ${request.documentType}`,
          },
        );
        delegatedAudit = authority.audit;
      }
      if (escalated && request.escalatedAt === null) {
        await tx
          .update(approvalRequests)
          .set({ escalatedAt: new Date() })
          .where(eq(approvalRequests.id, id));
      }
      if (!workflow?.allowSelfApproval && request.requestedBy === actor.id) {
        throw new BusinessRuleError(
          ErrorCodes.SOD_VIOLATION,
          'You cannot approve a document you submitted.',
        );
      }
      const all = await tx
        .select()
        .from(approvalDecisions)
        .where(eq(approvalDecisions.requestId, id));
      // Four-eyes across the chain: one decision per person per request.
      if (all.some((d) => d.decidedBy === actor.id))
        throw new BusinessRuleError(
          ErrorCodes.APPROVAL_NOT_ELIGIBLE,
          'You already decided an earlier step of this request.',
        );
      const prior = all.filter((d) => d.step === request.currentStep);
      await tx.insert(approvalDecisions).values({
        requestId: id,
        step: request.currentStep,
        decision: input.decision,
        comment: input.comment ?? null,
        decidedBy: actor.id,
      });
      let status: ApprovalRequestStatus = 'PENDING';
      let currentStep = request.currentStep;
      if (input.decision === 'REJECT') status = 'REJECTED';
      else if (prior.filter((d) => d.decision === 'APPROVE').length + 1 >= step.minApprovers) {
        currentStep += 1;
        if (currentStep >= request.steps.length) status = 'APPROVED';
      }
      await tx
        .update(approvalRequests)
        .set({ status, currentStep, completedAt: status === 'PENDING' ? null : new Date() })
        .where(eq(approvalRequests.id, id));
      await this.audit.record(
        {
          action: input.decision === 'APPROVE' ? 'APPROVE' : 'REJECT',
          module: MODULE,
          entityType: 'ApprovalRequest',
          entityId: id,
          newValue: {
            step: request.currentStep,
            decision: input.decision,
            status,
            comment: input.comment ?? null,
            escalated,
          },
          metadata: {
            actor: actor.email,
            documentNumber: request.documentNumber,
            ...delegatedAudit,
          },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, actor, id);
  }

  /**
   * Marks pending requests past their deadline as escalated (once) and audits
   * it, so the escalation approvers see them and the trail shows when the
   * deadline was missed. Called lazily from the list and by the dashboard.
   */
  async escalateOverdue(companyId: string): Promise<number> {
    const rows = await this.db
      .update(approvalRequests)
      .set({ escalatedAt: new Date() })
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          eq(approvalRequests.status, 'PENDING'),
          sql`${approvalRequests.dueAt} < now()`,
          sql`${approvalRequests.escalatedAt} is null`,
        ),
      )
      .returning({ id: approvalRequests.id, documentNumber: approvalRequests.documentNumber });
    for (const r of rows) {
      await this.audit.record({
        action: 'ESCALATE',
        module: MODULE,
        entityType: 'ApprovalRequest',
        entityId: r.id,
        newValue: { documentNumber: r.documentNumber, reason: 'Approval deadline passed' },
        companyId,
      });
    }
    return rows.length;
  }

  /** Pending / overdue counts for the control dashboard. */
  async pendingSummary(companyId: string): Promise<{ pending: number; overdue: number }> {
    await this.escalateOverdue(companyId);
    const [row] = await this.db
      .select({
        pending: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${approvalRequests.dueAt} < now())::int`,
      })
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.status, 'PENDING')),
      );
    return { pending: row?.pending ?? 0, overdue: row?.overdue ?? 0 };
  }

  // ----------------------------------------------------------------- helpers

  private enrich(
    row: ApprovalRequest & {
      workflowName: string;
      requestedByName: string | null;
      allowSelfApproval: boolean;
      escalationPermission: string | null;
    },
    decisions: ReadonlyArray<{ step: number; decidedBy: string }>,
    actorId: string,
    permissions: ReadonlySet<string>,
    delegations: readonly { permission: string }[] = [],
  ): ApprovalRequestView {
    const step: WorkflowStep | undefined = row.steps[row.currentStep];
    const approvalsSoFar = decisions.filter((d) => d.step === row.currentStep).length;
    const pendingApprovals = step ? Math.max(step.minApprovers - approvalsSoFar, 0) : 0;
    const overdue =
      row.status === 'PENDING' && row.dueAt !== null && row.dueAt.getTime() < Date.now();
    const eligible =
      Boolean(step) &&
      (permissions.has(step!.requiredPermission) ||
        delegations.some((d) => d.permission === step!.requiredPermission) ||
        (overdue &&
          row.escalationPermission !== null &&
          permissions.has(row.escalationPermission)));
    const canDecide =
      row.status === 'PENDING' &&
      eligible &&
      (row.allowSelfApproval || row.requestedBy !== actorId) &&
      !decisions.some((d) => d.decidedBy === actorId);
    const { allowSelfApproval: _a, ...rest } = row;
    return { ...rest, pendingApprovals, canDecide, overdue };
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(approvalRequests),
        workflowName: approvalWorkflows.name,
        allowSelfApproval: approvalWorkflows.allowSelfApproval,
        escalationPermission: approvalWorkflows.escalationPermission,
        requestedByName: sql<
          string | null
        >`(select u.first_name || ' ' || u.last_name from users u where u.id = ${sql.raw('"approval_requests"."requested_by"')})`,
      })
      .from(approvalRequests)
      .innerJoin(approvalWorkflows, eq(approvalWorkflows.id, approvalRequests.workflowId));
  }
}
