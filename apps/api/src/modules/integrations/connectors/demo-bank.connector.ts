import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  BaseConnector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type ConnectResult,
  type PullRequest,
  type PullResult,
} from '../core/connector';
import { IntegrationError } from '../core/integration-error';
import { fixtureArray, looksLikeDemoSecret, pageFromFixture, toRecords } from './demo-fixtures';

/**
 * Demo bank feed. Pulls statements (a balanced set of lines) that the
 * BankTransactionsImporter turns into bank statements for reconciliation.
 * Credentials: an API key of the form `demo-bank-...`.
 */
@Injectable()
export class DemoBankConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'DEMO_BANK',
    category: 'BANKING',
    name: 'Demo Bank',
    description: 'Bank feed simulator: statements with lines for reconciliation.',
    authType: 'API_KEY',
    capabilities: ['PULL', 'INCREMENTAL_SYNC', 'TEST_CONNECTION'],
    entities: ['bank-transactions'],
    configSchema: z.object({
      /** Internal bank account the feed belongs to. */
      bankAccountId: z.string().uuid(),
      accountNumber: z.string().max(40).optional(),
      fixture: z
        .object({ statements: z.array(z.record(z.string(), z.unknown())).max(500).optional() })
        .optional(),
    }),
    credentialFields: [{ key: 'apiKey', label: 'Feed API key (demo-bank-...)', required: true }],
    defaultMappings: {
      'bank-transactions': [
        {
          target: 'statementDate',
          source: 'statement_date',
          transforms: [{ name: 'toDate' }],
          required: true,
        },
        {
          target: 'openingBalance',
          source: 'opening_balance',
          transforms: [{ name: 'toDecimal' }],
          required: true,
        },
        {
          target: 'closingBalance',
          source: 'closing_balance',
          transforms: [{ name: 'toDecimal' }],
          required: true,
        },
        {
          target: 'lines',
          source: 'transactions',
          required: true,
          transforms: [
            {
              name: 'mapEach',
              arg: [
                {
                  target: 'lineDate',
                  source: 'date',
                  transforms: [{ name: 'toDate' }],
                  required: true,
                },
                {
                  target: 'description',
                  source: 'description',
                  transforms: [{ name: 'trim' }],
                  required: true,
                },
                { target: 'reference', source: 'reference', transforms: [] },
                {
                  target: 'amount',
                  source: 'amount',
                  transforms: [{ name: 'toDecimal' }],
                  required: true,
                },
              ],
            },
          ],
        },
      ],
    },
    rateLimitPerSecond: 5,
    demo: true,
  };

  override async connect(ctx: ConnectorContext): Promise<ConnectResult> {
    if (!looksLikeDemoSecret(ctx.secrets.apiKey, 'demo-bank-'))
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'Demo Bank rejected the API key (expected demo-bank-...).',
        { httpStatus: 401 },
      );
    return {
      ok: true,
      message: 'Demo Bank feed authorised',
      externalAccountId: String(ctx.config.accountNumber ?? 'DEMO-ACCT'),
    };
  }

  override async pull(ctx: ConnectorContext, req: PullRequest): Promise<PullResult> {
    if (!looksLikeDemoSecret(ctx.secrets.apiKey, 'demo-bank-'))
      throw new IntegrationError('AUTHENTICATION_ERROR', 'Demo Bank rejected the API key.', {
        httpStatus: 401,
      });
    if (req.entity !== 'bank-transactions')
      return { records: [], nextCursor: null, hasMore: false };
    const statements = fixtureArray(ctx.config, 'statements');
    return pageFromFixture(toRecords(statements, 'statement_id'), req.cursor, req.limit);
  }
}
