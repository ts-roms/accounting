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
 * (through the outbound push engine: export -> outbound mapping -> push) and
 * acknowledged with a receipt number that is kept as the external reference.
 * Submissions missing a document number or total are rejected per record, so
 * the job shows exactly which documents the authority refused. The connector
 * shows where a real government API (e-invoicing, e-receipts, filings) would
 * plug in; no actual agency API is assumed or invented here.
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
    /** Internal invoice detail -> e-invoice submission. */
    defaultOutboundMappings: {
      invoices: [
        { target: 'document_number', source: 'documentNumber', transforms: [], required: true },
        { target: 'document_type', source: 'documentType', transforms: [], required: true },
        { target: 'issue_date', source: 'documentDate', transforms: [], required: true },
        { target: 'due_date', source: 'dueDate', transforms: [] },
        { target: 'currency', source: 'currency', transforms: [{ name: 'upper' }] },
        { target: 'customer.code', source: 'customerCode', transforms: [] },
        { target: 'customer.name', source: 'customerName', transforms: [] },
        { target: 'amounts.net', source: 'subtotal', transforms: [], required: true },
        { target: 'amounts.tax', source: 'taxTotal', transforms: [] },
        { target: 'amounts.withholding', source: 'withholdingTotal', transforms: [] },
        { target: 'amounts.gross', source: 'total', transforms: [], required: true },
        { target: 'accounting_status', source: 'accountingStatus', transforms: [] },
        {
          target: 'lines',
          source: 'lines',
          required: true,
          transforms: [
            {
              name: 'mapEach',
              arg: [
                { target: 'description', source: 'description', transforms: [], required: true },
                { target: 'quantity', source: 'quantity', transforms: [] },
                { target: 'unit_price', source: 'unitPrice', transforms: [] },
                { target: 'amount', source: 'amount', transforms: [], required: true },
              ],
            },
          ],
        },
      ],
    },
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
    const submittedAt = new Date().toISOString();
    return {
      results: req.records.map((r) => {
        const number = r.data.document_number;
        const amounts = r.data.amounts as { gross?: unknown } | undefined;
        if (typeof number !== 'string' || !number)
          return {
            internalId: r.internalId,
            externalId: null,
            ok: false,
            error: 'document_number is required',
          };
        if (typeof amounts?.gross !== 'string' || Number(amounts.gross) < 0)
          return {
            internalId: r.internalId,
            externalId: null,
            ok: false,
            error: 'amounts.gross must be a non-negative decimal',
          };
        // A re-submission keeps its acknowledgement; the authority just records the new version.
        const externalId = r.externalId ?? `ACK-${randomUUID().slice(0, 8).toUpperCase()}`;
        return {
          internalId: r.internalId,
          externalId,
          ok: true,
          metadata: {
            submittedAt,
            documentNumber: number,
            version: r.externalId ? 'resubmission' : 'original',
          },
        };
      }),
    };
  }
}
