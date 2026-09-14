import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  BaseConnector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type ConnectResult,
  type PushRequest,
  type PushResult,
} from '../core/connector';
import { IntegrationError } from '../core/integration-error';
import { looksLikeDemoSecret } from './demo-fixtures';

/**
 * Demo tax / e-invoicing authority. Push-only: posted invoices are submitted
 * and acknowledged with a receipt number. The connector shows where a real
 * government API (e-invoicing, e-receipts, filings) would plug in; no actual
 * agency API is assumed or invented here.
 */
@Injectable()
export class DemoTaxAuthorityConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'DEMO_TAX_AUTHORITY',
    category: 'TAX',
    name: 'Demo Tax Authority (e-invoicing)',
    description: 'E-invoicing simulator: submits documents and returns acknowledgement numbers.',
    authType: 'API_KEY',
    capabilities: ['PUSH', 'TEST_CONNECTION'],
    entities: ['invoices'],
    configSchema: z.object({
      taxpayerId: z.string().min(3).max(40),
      environment: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
    }),
    credentialFields: [{ key: 'apiKey', label: 'Submission key (demo-tax-...)', required: true }],
    rateLimitPerSecond: 2,
    demo: true,
  };

  override async connect(ctx: ConnectorContext): Promise<ConnectResult> {
    if (!looksLikeDemoSecret(ctx.secrets.apiKey, 'demo-tax-'))
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'Tax authority rejected the submission key (expected demo-tax-...).',
        { httpStatus: 401 },
      );
    if (ctx.config.environment === 'PRODUCTION')
      throw new IntegrationError(
        'AUTHORIZATION_ERROR',
        'The demo authority only accepts SANDBOX submissions.',
        { httpStatus: 403 },
      );
    return { ok: true, message: `Taxpayer ${String(ctx.config.taxpayerId)} enrolled (sandbox)` };
  }

  async push(ctx: ConnectorContext, req: PushRequest): Promise<PushResult> {
    if (!looksLikeDemoSecret(ctx.secrets.apiKey, 'demo-tax-'))
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'Tax authority rejected the submission key.',
        { httpStatus: 401 },
      );
    return {
      results: req.records.map((r) => ({
        internalId: r.internalId,
        externalId: `ACK-${randomUUID().slice(0, 8).toUpperCase()}`,
        ok: true,
      })),
    };
  }
}
