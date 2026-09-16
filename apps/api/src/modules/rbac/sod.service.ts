import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { SodEnforcement } from '@accounting/types';
import type { UpsertSodPolicyInput } from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { shallowDiff } from '@/common/utils/diff';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { companies, sodPolicies, userRoles, users, type SodPolicy } from '@/database/schema';
import { PermissionResolverService } from './permission-resolver.service';

export interface SodConflict {
  policyId: string;
  policyName: string;
  permissionA: string;
  permissionB: string;
  enforcement: SodEnforcement;
}

export interface SodEvaluation {
  blocking: SodConflict[];
  warnings: SodConflict[];
}

/** A user who currently holds both permissions of a policy in one company scope. */
export interface SodUserConflict extends SodConflict {
  userId: string;
  userName: string;
  userEmail: string;
  companyId: string | null;
  companyName: string | null;
}

/** Document-level context recorded with a warned conflict. */
export interface SodDocumentRef {
  companyId?: string | null;
  entityType: string;
  entityId: string;
  documentNumber?: string | null;
}

/**
 * Segregation of duties. Policies are data owned by the organization; this
 * service evaluates them and never hard-codes a conflict pair.
 */
@Injectable()
export class SodService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly resolver: PermissionResolverService,
  ) {}

  /**
   * Pure evaluation: given the permissions a user would hold after a change,
   * return every active policy whose two permissions are both present.
   */
  evaluate(
    effectivePermissions: ReadonlySet<string>,
    policies: readonly SodPolicy[],
  ): SodEvaluation {
    const blocking: SodConflict[] = [];
    const warnings: SodConflict[] = [];
    for (const policy of policies) {
      if (!policy.isActive) continue;
      if (
        effectivePermissions.has(policy.permissionA) &&
        effectivePermissions.has(policy.permissionB)
      ) {
        const conflict: SodConflict = {
          policyId: policy.id,
          policyName: policy.name,
          permissionA: policy.permissionA,
          permissionB: policy.permissionB,
          enforcement: policy.enforcement,
        };
        (policy.enforcement === 'BLOCK' ? blocking : warnings).push(conflict);
      }
    }
    return { blocking, warnings };
  }

  /**
   * Throws SOD_VIOLATION for blocking conflicts and returns warnings for the
   * caller to record. Used before role assignment.
   */
  async assertAllowed(
    organizationId: string,
    effectivePermissions: ReadonlySet<string>,
    executor: DbExecutor = this.db,
  ): Promise<SodConflict[]> {
    const policies = await this.listActive(organizationId, executor);
    const result = this.evaluate(effectivePermissions, policies);
    if (result.blocking.length > 0) {
      throw new BusinessRuleError(
        ErrorCodes.SOD_VIOLATION,
        'This assignment violates a segregation-of-duties policy.',
        { conflicts: result.blocking },
      );
    }
    return result.warnings;
  }

  /**
   * Document-level separation: the person who performed step A on a document
   * (e.g. created it) must not perform step B (e.g. approve it) when a policy
   * for that permission pair exists. Uses the same policy data as assignment
   * checks - BLOCK throws, WARN returns the conflict for auditing.
   */
  async checkActorSeparation(
    organizationId: string,
    pair: [string, string],
    previousActorId: string | null | undefined,
    actorId: string,
    executor: DbExecutor = this.db,
    document?: SodDocumentRef,
  ): Promise<SodConflict | null> {
    if (!previousActorId || previousActorId !== actorId) return null;
    const policies = await this.listActive(organizationId, executor);
    const policy = policies.find(
      (p) =>
        (p.permissionA === pair[0] && p.permissionB === pair[1]) ||
        (p.permissionA === pair[1] && p.permissionB === pair[0]),
    );
    if (!policy) return null;
    const conflict: SodConflict = {
      policyId: policy.id,
      policyName: policy.name,
      permissionA: policy.permissionA,
      permissionB: policy.permissionB,
      enforcement: policy.enforcement,
    };
    if (policy.enforcement === 'BLOCK') {
      throw new BusinessRuleError(
        ErrorCodes.SOD_VIOLATION,
        `Segregation of duties: the same user cannot perform both "${pair[0]}" and "${pair[1]}" on one document.`,
        { conflicts: [conflict] },
      );
    }
    // A warned conflict is still a control event: it goes on the trail so the
    // control dashboard and auditors can see who overrode the separation.
    await this.audit.record(
      {
        action: 'SOD_WARNING',
        module: 'RBAC',
        entityType: document?.entityType ?? 'Document',
        entityId: document?.entityId ?? null,
        newValue: { ...conflict, actorId, documentNumber: document?.documentNumber ?? null },
        companyId: document?.companyId ?? undefined,
      },
      executor,
    );
    return conflict;
  }

  /**
   * Standing conflicts: every active user of the organization whose effective
   * permissions in some company scope hold both sides of an active policy.
   * Read-only; the control dashboard and the SoD screen show it.
   */
  async userConflicts(organizationId: string): Promise<SodUserConflict[]> {
    const policies = await this.listActive(organizationId);
    if (policies.length === 0) return [];
    const scopes = await this.db
      .selectDistinct({
        userId: users.id,
        userName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`,
        userEmail: users.email,
        companyId: userRoles.companyId,
        companyName: companies.name,
      })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .leftJoin(companies, eq(companies.id, userRoles.companyId))
      .where(
        and(
          eq(users.organizationId, organizationId),
          eq(users.status, 'ACTIVE'),
          or(isNull(userRoles.companyId), eq(companies.organizationId, organizationId)),
        ),
      );
    const out: SodUserConflict[] = [];
    for (const scope of scopes) {
      const access = await this.resolver.resolve(scope.userId, scope.companyId ?? undefined);
      const { blocking, warnings } = this.evaluate(access.permissions, policies);
      for (const c of [...blocking, ...warnings]) {
        out.push({
          ...c,
          userId: scope.userId,
          userName: scope.userName,
          userEmail: scope.userEmail,
          companyId: scope.companyId,
          companyName: scope.companyName,
        });
      }
    }
    // Organization-wide roles conflict in every company: report each pair once per user.
    const seen = new Set<string>();
    return out.filter((c) => {
      const key = `${c.userId}:${c.policyId}:${c.companyId ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async listActive(organizationId: string, executor: DbExecutor = this.db): Promise<SodPolicy[]> {
    return executor
      .select()
      .from(sodPolicies)
      .where(and(eq(sodPolicies.organizationId, organizationId), eq(sodPolicies.isActive, true)));
  }

  async list(organizationId: string): Promise<SodPolicy[]> {
    return this.db
      .select()
      .from(sodPolicies)
      .where(eq(sodPolicies.organizationId, organizationId))
      .orderBy(asc(sodPolicies.name));
  }

  async create(organizationId: string, input: UpsertSodPolicyInput): Promise<SodPolicy> {
    return this.db.transaction(async (tx) => {
      let created: SodPolicy | undefined;
      try {
        [created] = await tx
          .insert(sodPolicies)
          .values({ organizationId, ...input, description: input.description ?? null })
          .returning();
      } catch (err) {
        // One policy per permission pair and organization (the defaults are seeded).
        if (isUniqueViolation(err, 'sod_policies_org_pair_uq'))
          throw new DuplicateError(
            'SodPolicy',
            'permission pair',
            `${input.permissionA} / ${input.permissionB}`,
          );
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');
      await this.audit.record(
        {
          action: 'CREATE',
          module: 'RBAC',
          entityType: 'SodPolicy',
          entityId: created.id,
          newValue: created,
        },
        tx,
      );
      return created;
    });
  }

  async update(
    organizationId: string,
    id: string,
    input: UpsertSodPolicyInput,
  ): Promise<SodPolicy> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(sodPolicies)
        .where(and(eq(sodPolicies.id, id), eq(sodPolicies.organizationId, organizationId)))
        .for('update');
      if (!existing) throw new NotFoundError('SoD policy', id);

      const [updated] = await tx
        .update(sodPolicies)
        .set({ ...input, description: input.description ?? null })
        .where(eq(sodPolicies.id, id))
        .returning();
      if (!updated) throw new Error('Update returned no row');

      const { previous, next } = shallowDiff(existing, updated);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: 'RBAC',
          entityType: 'SodPolicy',
          entityId: id,
          previousValue: previous,
          newValue: next,
        },
        tx,
      );
      return updated;
    });
  }
}
