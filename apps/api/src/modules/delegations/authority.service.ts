import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { DelegatedGrant, DelegationDocumentType, PermissionKey } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { RequestContext } from '@/common/context/request-context';
import { BusinessRuleError, PermissionDeniedError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { delegationUsage, delegations } from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { PermissionResolverService } from '@/modules/rbac/permission-resolver.service';
import { selectGrant } from './delegation.logic';
import { DelegationsService } from './delegations.service';

const MODULE = 'DELEGATIONS';

export interface AuthorityDocument {
  companyId: string;
  branchId?: string | null;
  amount?: string | null;
  currency?: string | null;
  documentType: DelegationDocumentType;
  documentId: string;
  documentNumber?: string | null;
  /** Creator / submitter of the document (for the self-approval rule). */
  createdBy?: string | null;
  /** Human action for the trail, e.g. "Approved vendor bill". */
  action: string;
}

export interface AuthorityResult {
  delegated: boolean;
  grant?: DelegatedGrant;
  /** Metadata to attach to the document's own audit entry. */
  audit?: Record<string, unknown>;
}

/**
 * The approval-engine hook (spec section 32):
 *
 *   required authority -> own permission? -> active delegation? -> scope
 *   -> amount limit -> SoD / self-approval -> record usage -> approve
 *
 * Services call `assert` inside their transaction before an approval-type
 * action. When the actor holds the permission natively nothing changes; when
 * they act under delegation the grant is re-validated against the database
 * (status, window, delegator still authorised) and a usage row plus an audit
 * entry naming the original authority are written in the same transaction.
 */
@Injectable()
export class AuthorityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly delegations: DelegationsService,
    private readonly resolver: PermissionResolverService,
    private readonly audit: AuditService,
  ) {}

  async assert(
    tx: DbExecutor,
    actor: AuthenticatedUser,
    permission: PermissionKey,
    doc: AuthorityDocument,
  ): Promise<AuthorityResult> {
    if (actor.permissions.has(permission) || actor.system) return { delegated: false };
    const now = new Date();
    const grants =
      actor.delegations ?? (await this.delegations.grantsFor(actor.id, doc.companyId, tx));
    const selection = selectGrant(grants, permission, {
      now,
      companyId: doc.companyId,
      branchId: doc.branchId ?? null,
      amount: doc.amount ?? null,
      currency: doc.currency ?? null,
      documentCreatedBy: doc.createdBy ?? null,
      actingUserId: actor.id,
    });
    if (!selection) throw new PermissionDeniedError([permission]);
    if (!selection.verdict.ok) {
      const v = selection.verdict;
      const code =
        v.code === 'AMOUNT' || v.code === 'CURRENCY'
          ? ErrorCodes.DELEGATION_LIMIT_EXCEEDED
          : v.code === 'SELF_APPROVAL' || v.code === 'DELEGATOR_SELF'
            ? ErrorCodes.SOD_VIOLATION
            : ErrorCodes.DELEGATION_SCOPE_EXCEEDED;
      throw new BusinessRuleError(code, v.message, {
        delegation: selection.grant.delegationNumber,
        rule: v.code,
      });
    }
    const grant = selection.grant;

    // Re-validate against the database inside the transaction (revocation / expiry are immediate).
    const [row] = await tx
      .select()
      .from(delegations)
      .where(and(eq(delegations.id, grant.delegationId), eq(delegations.status, 'ACTIVE')))
      .for('update');
    if (!row || row.startAt > now || row.endAt <= now)
      throw new BusinessRuleError(
        ErrorCodes.DELEGATION_INVALID_STATE,
        `Delegation ${grant.delegationNumber} is no longer in effect.`,
      );
    const policy = await this.delegations.policy(actor.organizationId, tx);
    if (policy.revalidateAtUse) {
      const delegator = await this.resolver.resolve(row.delegatorUserId, doc.companyId, tx);
      if (!delegator.permissions.has(permission))
        throw new BusinessRuleError(
          ErrorCodes.DELEGATION_NOT_PERMITTED,
          `${grant.delegatorName} no longer holds ${permission}; the delegation cannot grant it.`,
          { delegation: grant.delegationNumber },
        );
    }

    const ctx = RequestContext.get();
    await tx.insert(delegationUsage).values({
      delegationId: row.id,
      organizationId: row.organizationId,
      companyId: doc.companyId,
      branchId: doc.branchId ?? null,
      delegateUserId: actor.id,
      delegatorUserId: row.delegatorUserId,
      permission,
      action: doc.action,
      documentType: doc.documentType,
      documentId: doc.documentId,
      documentNumber: doc.documentNumber ?? null,
      amount: doc.amount ?? null,
      currency: doc.currency ?? null,
      correlationId: ctx?.correlationId ?? null,
    });
    await tx
      .update(delegations)
      .set({ usageCount: sql`${delegations.usageCount} + 1` })
      .where(eq(delegations.id, row.id));
    const auditMeta = {
      originalAuthority: { userId: row.delegatorUserId, name: grant.delegatorName },
      actingUser: {
        userId: actor.id,
        email: actor.email,
        name: `${actor.firstName} ${actor.lastName}`,
      },
      delegation: grant.delegationNumber,
      delegationId: row.id,
      permission,
      action: doc.action,
      document: {
        type: doc.documentType,
        id: doc.documentId,
        number: doc.documentNumber ?? null,
        amount: doc.amount ?? null,
        currency: doc.currency ?? null,
      },
      reason: row.reason,
      validUntil: row.endAt,
    };
    await this.audit.record(
      {
        action: 'DELEGATION_USE',
        module: MODULE,
        entityType: 'Delegation',
        entityId: row.id,
        newValue: auditMeta,
        companyId: doc.companyId,
      },
      tx,
    );
    return { delegated: true, grant, audit: { delegatedAuthority: auditMeta } };
  }
}
