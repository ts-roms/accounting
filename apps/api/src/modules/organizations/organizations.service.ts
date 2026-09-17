import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type {
  CreateBranchInput,
  CreateCompanyInput,
  UpdateBranchInput,
  UpdateCompanyInput,
  UpdateOrganizationInput,
} from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthorizationCacheService } from '@/modules/rbac/authorization-cache.service';
import { DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { shallowDiff } from '@/common/utils/diff';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  branches,
  companies,
  organizations,
  type Branch,
  type Company,
  type Organization,
} from '@/database/schema';

const MODULE = 'ORGANIZATIONS';

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly cache: AuthorizationCacheService,
  ) {}

  // ---------------------------------------------------------------- organization

  async getOrganization(id: string, executor: DbExecutor = this.db): Promise<Organization> {
    const [org] = await executor.select().from(organizations).where(eq(organizations.id, id));
    if (!org) throw new NotFoundError('Organization', id);
    return org;
  }

  async updateOrganization(id: string, input: UpdateOrganizationInput): Promise<Organization> {
    return this.db.transaction(async (tx) => {
      const existing = await this.getOrganization(id, tx);
      const [updated] = await tx
        .update(organizations)
        .set({
          name: input.name ?? existing.name,
          baseCurrency: input.baseCurrency ?? existing.baseCurrency,
          timezone: input.timezone ?? existing.timezone,
        })
        .where(eq(organizations.id, id))
        .returning();
      if (!updated) throw new Error('Update returned no row');
      // Company status changes what every user may access.
      this.cache.invalidateAll();
      const { previous, next } = shallowDiff(existing, updated);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Organization',
          entityId: id,
          previousValue: previous,
          newValue: next,
        },
        tx,
      );
      return updated;
    });
  }

  // ------------------------------------------------------------------- companies

  async listCompanies(organizationId: string): Promise<Company[]> {
    return this.db
      .select()
      .from(companies)
      .where(eq(companies.organizationId, organizationId))
      .orderBy(asc(companies.code));
  }

  /** Companies the caller may act in (used by the auth guard and the UI switcher). */
  async listAccessibleCompanies(
    organizationId: string,
    companyIds: string[] | 'ALL',
  ): Promise<Company[]> {
    if (companyIds !== 'ALL' && companyIds.length === 0) return [];
    const where =
      companyIds === 'ALL'
        ? and(eq(companies.organizationId, organizationId), eq(companies.status, 'ACTIVE'))
        : and(
            eq(companies.organizationId, organizationId),
            eq(companies.status, 'ACTIVE'),
            inArray(companies.id, companyIds),
          );
    return this.db.select().from(companies).where(where).orderBy(asc(companies.code));
  }

  async getCompany(
    organizationId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<Company> {
    const [company] = await executor
      .select()
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)));
    if (!company) throw new NotFoundError('Company', id);
    return company;
  }

  async createCompany(organizationId: string, input: CreateCompanyInput): Promise<Company> {
    return this.db.transaction(async (tx) => {
      let created: Company | undefined;
      try {
        [created] = await tx
          .insert(companies)
          .values({ organizationId, ...nullify(input) })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'companies_org_code_uq'))
          throw new DuplicateError('Company', 'code', input.code);
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Company',
          entityId: created.id,
          newValue: created,
          companyId: created.id,
        },
        tx,
      );
      return created;
    });
  }

  async updateCompany(
    organizationId: string,
    id: string,
    input: UpdateCompanyInput,
  ): Promise<Company> {
    return this.db.transaction(async (tx) => {
      const existing = await this.getCompany(organizationId, id, tx);
      let updated: Company | undefined;
      try {
        [updated] = await tx
          .update(companies)
          .set(definedOnly(input))
          .where(eq(companies.id, id))
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'companies_org_code_uq'))
          throw new DuplicateError('Company', 'code', input.code ?? '');
        throw err;
      }
      if (!updated) throw new Error('Update returned no row');
      const { previous, next } = shallowDiff(existing, updated);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Company',
          entityId: id,
          previousValue: previous,
          newValue: next,
          companyId: id,
        },
        tx,
      );
      return updated;
    });
  }

  // -------------------------------------------------------------------- branches

  async listBranches(organizationId: string, companyId?: string): Promise<Branch[]> {
    const rows = await this.db
      .select({ branch: branches })
      .from(branches)
      .innerJoin(companies, eq(companies.id, branches.companyId))
      .where(
        companyId
          ? and(eq(companies.organizationId, organizationId), eq(branches.companyId, companyId))
          : eq(companies.organizationId, organizationId),
      )
      .orderBy(asc(branches.code));
    return rows.map((r) => r.branch);
  }

  async getBranch(
    organizationId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<Branch> {
    const [row] = await executor
      .select({ branch: branches })
      .from(branches)
      .innerJoin(companies, eq(companies.id, branches.companyId))
      .where(and(eq(branches.id, id), eq(companies.organizationId, organizationId)));
    if (!row) throw new NotFoundError('Branch', id);
    return row.branch;
  }

  async createBranch(organizationId: string, input: CreateBranchInput): Promise<Branch> {
    return this.db.transaction(async (tx) => {
      await this.getCompany(organizationId, input.companyId, tx); // ownership check
      let created: Branch | undefined;
      try {
        [created] = await tx.insert(branches).values(nullify(input)).returning();
      } catch (err) {
        if (isUniqueViolation(err, 'branches_company_code_uq'))
          throw new DuplicateError('Branch', 'code', input.code);
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Branch',
          entityId: created.id,
          newValue: created,
          companyId: created.companyId,
        },
        tx,
      );
      return created;
    });
  }

  async updateBranch(
    organizationId: string,
    id: string,
    input: UpdateBranchInput,
  ): Promise<Branch> {
    return this.db.transaction(async (tx) => {
      const existing = await this.getBranch(organizationId, id, tx);
      let updated: Branch | undefined;
      try {
        [updated] = await tx
          .update(branches)
          .set(definedOnly(input))
          .where(eq(branches.id, id))
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'branches_company_code_uq'))
          throw new DuplicateError('Branch', 'code', input.code ?? '');
        throw err;
      }
      if (!updated) throw new Error('Update returned no row');
      const { previous, next } = shallowDiff(existing, updated);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Branch',
          entityId: id,
          previousValue: previous,
          newValue: next,
          companyId: existing.companyId,
        },
        tx,
      );
      return updated;
    });
  }
}

/** Zod yields `undefined` for cleared optional text; Postgres wants NULL. */
function nullify<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]: T[K] extends undefined ? null : T[K] } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = v === undefined ? null : v;
  return out as { [K in keyof T]: T[K] extends undefined ? null : T[K] };
}

/** For PATCH semantics: keep only keys the caller actually sent (undefined = untouched). */
function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
