import { and, eq } from 'drizzle-orm';
import { CredentialCipher } from '@/modules/integrations/core/credential-cipher';
import * as schema from '../schema';
import type { Tx } from './seed';

type Log = (m: string) => void;

/**
 * Demo integrations (Prompt #4). Credentials are demo-shaped placeholders the
 * mock connectors accept (`demo-bank-...`); nothing here is a real secret and
 * none of the providers reach the network. Idempotent by integration name.
 */
const DEMO_INTEGRATIONS = [
  {
    name: 'Demo Bank',
    provider: 'DEMO_BANK',
    category: 'BANKING' as const,
    authType: 'API_KEY' as const,
    capabilities: ['PULL', 'INCREMENTAL_SYNC', 'TEST_CONNECTION'],
    scopes: ['banking:read', 'banking:write'],
    secrets: { apiKey: 'demo-bank-sandbox-key' },
    config: (ctx: SeedContext) => ({
      bankAccountId: ctx.bankAccountId,
      accountNumber: '0012-3456-7890',
      fixture: {
        statements: [
          {
            statement_id: 'STMT-2026-01',
            statement_date: '2026-01-31',
            opening_balance: '0.00',
            closing_balance: '12500.00',
            transactions: [
              {
                date: '2026-01-15',
                description: 'Customer transfer - Northwind',
                reference: 'NW-1001',
                amount: '15000.00',
              },
              {
                date: '2026-01-20',
                description: 'Bank service charge',
                reference: 'FEE',
                amount: '-2500.00',
              },
            ],
          },
        ],
      },
    }),
  },
  {
    name: 'Demo Payment Gateway',
    provider: 'DEMO_PAYMENT_GATEWAY',
    category: 'PAYMENT' as const,
    authType: 'HMAC' as const,
    capabilities: ['PULL', 'WEBHOOKS', 'INCREMENTAL_SYNC', 'TEST_CONNECTION'],
    scopes: ['customers:write', 'payments:write', 'invoices:read'],
    secrets: { apiKey: 'demo-pg-sandbox-secret', webhookSecret: 'demo-pg-webhook-signing-secret' },
    config: (ctx: SeedContext) => ({
      cashAccountId: ctx.cashAccountId,
      autoPost: false,
      fixture: { customers: [], payments: [] },
    }),
  },
  {
    name: 'Demo E-Commerce',
    provider: 'DEMO_ECOMMERCE',
    category: 'ECOMMERCE' as const,
    authType: 'BEARER' as const,
    capabilities: ['PULL', 'WEBHOOKS', 'INCREMENTAL_SYNC', 'TEST_CONNECTION'],
    scopes: ['customers:write', 'invoices:write'],
    secrets: {
      bearerToken: 'demo-shop-sandbox-token',
      webhookSecret: 'demo-shop-webhook-hmac-secret',
    },
    config: () => ({
      storeUrl: 'https://demo-store.example',
      autoPost: false,
      fixture: {
        customers: [
          {
            id: 'c_1001',
            name: 'Sunrise Trading',
            email: 'orders@sunrise.example',
            phone: '+63 917 000 1001',
            address: { line1: '12 Mabini St', city: 'Davao City', country: 'PH' },
          },
          {
            id: 'c_1002',
            name: 'Harbor Cafe',
            email: 'hello@harborcafe.example',
            address: { line1: '5 Port Rd', city: 'Cebu City', country: 'PH' },
          },
        ],
        orders: [
          {
            id: 'o_5001',
            order_number: 'SO-5001',
            customer_id: 'c_1001',
            created_at: '2026-02-03T08:15:00Z',
            currency: 'PHP',
            note: 'Web order',
            line_items: [
              { title: 'Consulting hours', quantity: '10', price: '1500.00' },
              { title: 'Onboarding package', quantity: '1', price: '4500.00' },
            ],
          },
        ],
      },
    }),
  },
  {
    name: 'Demo Tax Provider',
    provider: 'DEMO_TAX_AUTHORITY',
    category: 'TAX' as const,
    authType: 'API_KEY' as const,
    capabilities: ['PUSH', 'TEST_CONNECTION'],
    scopes: ['invoices:read'],
    secrets: { apiKey: 'demo-tax-sandbox-key' },
    config: () => ({ taxpayerId: '123-456-789-000', environment: 'SANDBOX' }),
  },
];

interface SeedContext {
  bankAccountId: string;
  cashAccountId: string;
}

export async function seedIntegrations(
  tx: Tx,
  organizationId: string,
  adminUserId: string,
  log: Log,
): Promise<void> {
  const [company] = await tx
    .select()
    .from(schema.companies)
    .where(
      and(eq(schema.companies.organizationId, organizationId), eq(schema.companies.code, 'ACME')),
    );
  if (!company) return;
  const [bank] = await tx
    .select({ id: schema.bankAccounts.id, glAccountId: schema.bankAccounts.glAccountId })
    .from(schema.bankAccounts)
    .where(
      and(eq(schema.bankAccounts.companyId, company.id), eq(schema.bankAccounts.code, 'BDO-MAIN')),
    );
  if (!bank) return;
  const cipher = new CredentialCipher(
    process.env.INTEGRATION_ENCRYPTION_KEY ?? `dev:${process.env.JWT_ACCESS_SECRET ?? 'seed'}`,
  );
  const ctx: SeedContext = { bankAccountId: bank.id, cashAccountId: bank.glAccountId };
  let created = 0;
  for (const def of DEMO_INTEGRATIONS) {
    const [existing] = await tx
      .select({ id: schema.integrations.id })
      .from(schema.integrations)
      .where(
        and(
          eq(schema.integrations.organizationId, organizationId),
          eq(schema.integrations.name, def.name),
        ),
      );
    if (existing) continue;
    const [row] = await tx
      .insert(schema.integrations)
      .values({
        organizationId,
        companyId: company.id,
        provider: def.provider,
        category: def.category,
        name: def.name,
        status: 'CONNECTED',
        healthStatus: 'HEALTHY',
        healthScore: 100,
        authType: def.authType,
        config: def.config(ctx),
        capabilities: def.capabilities,
        createdBy: adminUserId,
        connectedAt: new Date(),
        lastSuccessAt: new Date(),
      })
      .returning({ id: schema.integrations.id });
    await tx
      .insert(schema.integrationScopes)
      .values(def.scopes.map((scope) => ({ integrationId: row!.id, scope })));
    const secrets = def.secrets as Record<string, string | undefined>;
    const rows: Array<{
      kind: 'API_KEY' | 'BEARER' | 'WEBHOOK_SECRET';
      value: Record<string, string>;
    }> = [];
    if (secrets.apiKey) rows.push({ kind: 'API_KEY', value: { apiKey: secrets.apiKey } });
    if (secrets.bearerToken)
      rows.push({ kind: 'BEARER', value: { bearerToken: secrets.bearerToken } });
    if (secrets.webhookSecret)
      rows.push({ kind: 'WEBHOOK_SECRET', value: { webhookSecret: secrets.webhookSecret } });
    await tx
      .insert(schema.integrationCredentials)
      .values(
        rows.map((r) => ({
          integrationId: row!.id,
          kind: r.kind,
          ciphertext: cipher.encryptJson(r.value),
        })),
      );
    created += 1;
  }
  log(`demo integrations ensured (${created} created)`);
}

/**
 * Sample delegation: the Finance Manager lends AP bill approval (up to
 * PHP 500,000) to the Accountant for 14 days. Seeded ACTIVE (approved by the
 * administrator) so the approval screens can show delegated authority.
 */
export async function seedSampleDelegation(
  tx: Tx,
  organizationId: string,
  adminUserId: string,
  log: Log,
): Promise<void> {
  const [company] = await tx
    .select({ id: schema.companies.id, baseCurrency: schema.companies.baseCurrency })
    .from(schema.companies)
    .where(
      and(eq(schema.companies.organizationId, organizationId), eq(schema.companies.code, 'ACME')),
    );
  const users = await tx
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.organizationId, organizationId));
  const delegator = users.find((u) => u.email === 'finance@acme.local');
  const delegate = users.find((u) => u.email === 'accountant@acme.local');
  if (!company || !delegator || !delegate) return;
  const [existing] = await tx
    .select({ id: schema.delegations.id })
    .from(schema.delegations)
    .where(
      and(
        eq(schema.delegations.organizationId, organizationId),
        eq(schema.delegations.delegationNumber, 'DLG-000001'),
      ),
    );
  if (existing) return;
  const startAt = new Date();
  const endAt = new Date(startAt.getTime() + 14 * 24 * 3600 * 1000);
  const [row] = await tx
    .insert(schema.delegations)
    .values({
      organizationId,
      companyId: company.id,
      delegationNumber: 'DLG-000001',
      delegatorUserId: delegator.id,
      delegateUserId: delegate.id,
      startAt,
      endAt,
      status: 'ACTIVE',
      reason: 'Leave coverage: AP bill approval while the Finance Manager is away',
      requiredApprovals: 1,
      createdBy: delegator.id,
      approvedBy: adminUserId,
      approvedAt: startAt,
    })
    .returning({ id: schema.delegations.id });
  await tx.insert(schema.delegationScopes).values({
    delegationId: row!.id,
    permission: 'bill.approve',
    maxAmount: '500000.0000',
    currency: company.baseCurrency,
  });
  await tx.insert(schema.delegationApprovals).values({
    delegationId: row!.id,
    approverUserId: adminUserId,
    decision: 'APPROVE',
    comment: 'Seeded sample delegation',
  });
  await tx
    .insert(schema.delegationPolicies)
    .values({ organizationId, approvalPolicy: 'MANAGER_APPROVAL' })
    .onConflictDoNothing();
  log('sample delegation DLG-000001 ensured (finance -> accountant, bill.approve <= 500,000)');
}
