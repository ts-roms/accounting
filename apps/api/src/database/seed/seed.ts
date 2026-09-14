import crypto from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import {
  DEFAULT_SOD_POLICIES,
  PERMISSION_DEFINITIONS,
  SYSTEM_ROLE_DEFINITIONS,
  type SystemRoleKey,
} from '@accounting/types';
import * as schema from '../schema';
import { seedAccounting } from './accounting.seed';
import { seedIntegrations, seedSampleDelegation } from './integrations.seed';

/** Identity that owns scheduled postings (depreciation job). Never logs in. */
export const SYSTEM_USER_EMAIL = 'scheduler@system.local';

type Db = ReturnType<typeof drizzle<typeof schema>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface SeedOptions {
  adminEmail?: string;
  adminPassword?: string;
  demoPassword?: string;
  /** Skip the demo (non-admin) users - used by tests. */
  demoUsers?: boolean;
  /** Skip the demo integrations and the sample delegation (Prompt #4). */
  demoIntegrations?: boolean;
  log?: (msg: string) => void;
}

/**
 * Idempotent development seed. Safe to re-run: catalog rows are upserted,
 * entities are looked up by natural key before insertion.
 *
 * Phase 1 seeds the tenancy, security and audit foundation. Chart of accounts,
 * customers, vendors, products and sample documents arrive with their phases.
 */
export async function runSeed(connectionString: string, options: SeedOptions = {}): Promise<void> {
  const log = options.log ?? ((m: string) => console.warn(`[seed] ${m}`));
  const pool = new Pool({ connectionString, max: 2 });
  const db = drizzle(pool, { schema });
  try {
    await db.transaction(async (tx) => {
      await syncPermissions(tx, log);
      const org = await ensureOrganization(tx, log);
      await ensureCompaniesAndBranches(tx, org.id, log);
      await syncSystemRoles(tx, org.id, log);
      await ensureSodPolicies(tx, org.id, log);
      const adminId = await ensureUsers(tx, org.id, options, log);
      await seedAccounting(tx, org.id, adminId, log);
      if (options.demoIntegrations !== false) {
        await seedIntegrations(tx, org.id, adminId, log);
        if (options.demoUsers !== false) await seedSampleDelegation(tx, org.id, adminId, log);
      }
    });
  } finally {
    await pool.end();
  }
}

async function syncPermissions(tx: Tx, log: (m: string) => void): Promise<void> {
  await tx
    .insert(schema.permissions)
    .values(
      PERMISSION_DEFINITIONS.map((p) => ({
        key: p.key,
        module: p.module,
        description: p.description,
      })),
    )
    .onConflictDoUpdate({
      target: schema.permissions.key,
      set: { module: sqlExcluded('module'), description: sqlExcluded('description') },
    });
  log(`permissions synced (${PERMISSION_DEFINITIONS.length})`);
}

async function ensureOrganization(tx: Tx, log: (m: string) => void) {
  const slug = 'acme';
  const [existing] = await tx
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug));
  if (existing) return existing;
  const [created] = await tx
    .insert(schema.organizations)
    .values({ name: 'Acme Holdings', slug, baseCurrency: 'PHP', timezone: 'Asia/Manila' })
    .returning();
  if (!created) throw new Error('organization insert failed');
  log(`organization created: ${created.name}`);
  return created;
}

async function ensureCompaniesAndBranches(
  tx: Tx,
  organizationId: string,
  log: (m: string) => void,
) {
  const companiesToSeed = [
    {
      code: 'ACME',
      name: 'Acme Trading Corporation',
      legalName: 'Acme Trading Corporation',
      taxIdentificationNumber: '000-123-456-000',
      baseCurrency: 'PHP',
      fiscalYearStartMonth: 1,
      addressLine1: 'J.C. Aquino Avenue',
      city: 'Butuan City',
      province: 'Agusan del Norte',
      postalCode: '8600',
      country: 'PH',
      branches: [
        {
          code: 'BXU',
          name: 'Butuan Head Office',
          isHeadOffice: true,
          city: 'Butuan City',
          province: 'Agusan del Norte',
        },
        {
          code: 'DVO',
          name: 'Davao Branch',
          isHeadOffice: false,
          city: 'Davao City',
          province: 'Davao del Sur',
        },
        {
          code: 'CEB',
          name: 'Cebu Branch',
          isHeadOffice: false,
          city: 'Cebu City',
          province: 'Cebu',
        },
      ],
    },
    {
      code: 'ACMS',
      name: 'Acme Services Inc.',
      legalName: 'Acme Services Incorporated',
      taxIdentificationNumber: '000-654-321-000',
      baseCurrency: 'PHP',
      fiscalYearStartMonth: 1,
      city: 'Davao City',
      province: 'Davao del Sur',
      country: 'PH',
      branches: [
        {
          code: 'DVO',
          name: 'Davao Head Office',
          isHeadOffice: true,
          city: 'Davao City',
          province: 'Davao del Sur',
        },
      ],
    },
  ];

  for (const { branches, ...company } of companiesToSeed) {
    let [row] = await tx
      .select()
      .from(schema.companies)
      .where(
        and(
          eq(schema.companies.organizationId, organizationId),
          eq(schema.companies.code, company.code),
        ),
      );
    if (!row) {
      [row] = await tx
        .insert(schema.companies)
        .values({ organizationId, ...company })
        .returning();
      log(`company created: ${company.code}`);
    }
    if (!row) throw new Error('company insert failed');
    for (const branch of branches) {
      const [existing] = await tx
        .select({ id: schema.branches.id })
        .from(schema.branches)
        .where(and(eq(schema.branches.companyId, row.id), eq(schema.branches.code, branch.code)));
      if (!existing) {
        await tx.insert(schema.branches).values({ companyId: row.id, country: 'PH', ...branch });
        log(`branch created: ${company.code}/${branch.code}`);
      }
    }
  }
}

async function syncSystemRoles(tx: Tx, organizationId: string, log: (m: string) => void) {
  const permissionRows = await tx
    .select({ id: schema.permissions.id, key: schema.permissions.key })
    .from(schema.permissions);
  const permissionIdByKey = new Map(permissionRows.map((p) => [p.key, p.id]));

  for (const def of SYSTEM_ROLE_DEFINITIONS) {
    let [role] = await tx
      .select()
      .from(schema.roles)
      .where(and(eq(schema.roles.organizationId, organizationId), eq(schema.roles.key, def.key)));
    if (!role) {
      [role] = await tx
        .insert(schema.roles)
        .values({
          organizationId,
          key: def.key,
          name: def.name,
          description: def.description,
          isSystem: true,
        })
        .returning();
      log(`role created: ${def.key}`);
    }
    if (!role) throw new Error('role insert failed');

    // System roles: permissions are re-synchronised so new catalog entries propagate.
    const desired = def.permissions
      .map((k) => permissionIdByKey.get(k))
      .filter((id): id is string => Boolean(id));
    await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, role.id));
    if (desired.length > 0) {
      await tx
        .insert(schema.rolePermissions)
        .values(desired.map((permissionId) => ({ roleId: role.id, permissionId })));
    }
  }
  log(`system roles synced (${SYSTEM_ROLE_DEFINITIONS.length})`);
}

async function ensureSodPolicies(tx: Tx, organizationId: string, log: (m: string) => void) {
  for (const policy of DEFAULT_SOD_POLICIES) {
    await tx
      .insert(schema.sodPolicies)
      .values({ organizationId, ...policy })
      .onConflictDoNothing({
        target: [
          schema.sodPolicies.organizationId,
          schema.sodPolicies.permissionA,
          schema.sodPolicies.permissionB,
        ],
      });
  }
  log(`SoD policies ensured (${DEFAULT_SOD_POLICIES.length})`);
}

async function ensureUsers(
  tx: Tx,
  organizationId: string,
  options: SeedOptions,
  log: (m: string) => void,
) {
  const adminEmail = options.adminEmail ?? process.env.SEED_ADMIN_EMAIL ?? 'admin@acme.local';
  const adminPassword =
    options.adminPassword ?? process.env.SEED_ADMIN_PASSWORD ?? 'Admin!Passw0rd';
  const demoPassword = options.demoPassword ?? process.env.SEED_DEMO_PASSWORD ?? 'Demo!Passw0rd';

  const demo: Array<{
    email: string;
    firstName: string;
    lastName: string;
    roles: SystemRoleKey[];
    password: string;
  }> = [
    {
      email: adminEmail,
      firstName: 'System',
      lastName: 'Administrator',
      roles: ['SUPER_ADMIN'],
      password: adminPassword,
    },
  ];
  if (options.demoUsers !== false) {
    demo.push(
      {
        email: 'accountant@acme.local',
        firstName: 'Ana',
        lastName: 'Reyes',
        roles: ['ACCOUNTANT'],
        password: demoPassword,
      },
      {
        email: 'finance@acme.local',
        firstName: 'Marco',
        lastName: 'Santos',
        roles: ['FINANCE_MANAGER'],
        password: demoPassword,
      },
      {
        email: 'auditor@acme.local',
        firstName: 'Liza',
        lastName: 'Cruz',
        roles: ['AUDITOR'],
        password: demoPassword,
      },
      {
        email: 'viewer@acme.local',
        firstName: 'Paolo',
        lastName: 'Garcia',
        roles: ['VIEWER'],
        password: demoPassword,
      },
    );
  }

  const roleRows = await tx
    .select({ id: schema.roles.id, key: schema.roles.key })
    .from(schema.roles)
    .where(
      and(
        eq(schema.roles.organizationId, organizationId),
        inArray(
          schema.roles.key,
          demo.flatMap((d) => d.roles),
        ),
      ),
    );
  const roleIdByKey = new Map(roleRows.map((r) => [r.key, r.id]));

  for (const u of demo) {
    let [user] = await tx.select().from(schema.users).where(eq(schema.users.email, u.email));
    if (!user) {
      const passwordHash = await argon2.hash(u.password, {
        type: argon2.argon2id,
        memoryCost: 19 * 1024,
        timeCost: 2,
        parallelism: 1,
      });
      [user] = await tx
        .insert(schema.users)
        .values({
          organizationId,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          passwordHash,
        })
        .returning();
      log(`user created: ${u.email}`);
    }
    if (!user) throw new Error('user insert failed');

    for (const roleKey of u.roles) {
      const roleId = roleIdByKey.get(roleKey);
      if (!roleId) continue;
      const [existing] = await tx
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.userId, user.id),
            eq(schema.userRoles.roleId, roleId),
            isNull(schema.userRoles.companyId),
          ),
        );
      if (!existing)
        await tx.insert(schema.userRoles).values({ userId: user.id, roleId, companyId: null });
    }
  }
  // Scheduler identity: cannot sign in (INACTIVE, random secret), but owns automated postings.
  const [scheduler] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, SYSTEM_USER_EMAIL));
  if (!scheduler) {
    await tx.insert(schema.users).values({
      organizationId,
      email: SYSTEM_USER_EMAIL,
      firstName: 'System',
      lastName: 'Scheduler',
      passwordHash: await argon2.hash(crypto.randomUUID(), {
        type: argon2.argon2id,
        memoryCost: 19 * 1024,
        timeCost: 2,
        parallelism: 1,
      }),
      status: 'INACTIVE',
    });
    log('system scheduler user created');
  }
  log(`users ensured (${demo.length})`);
  const [admin] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, adminEmail));
  if (!admin) throw new Error('admin user missing after seed');
  return admin.id;
}

/** `excluded.<column>` reference for ON CONFLICT DO UPDATE. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
