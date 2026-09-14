import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  BaseConnector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type ConnectResult,
  type OAuthTokens,
  type PullRequest,
  type PullResult,
} from '../core/connector';
import { IntegrationError } from '../core/integration-error';
import { fixtureArray, pageFromFixture, toRecords } from './demo-fixtures';

/**
 * Demo CRM connected through OAuth 2.0 (authorisation code + PKCE). The
 * provider's endpoints are stand-ins: the code exchange and refresh are
 * implemented on the connector so the whole flow (state, callback, token
 * storage, refresh, revoke) runs without a network. A real CRM connector
 * (Salesforce, HubSpot) would drop the overrides and let the platform call
 * `descriptor.oauth.tokenUrl`.
 */
@Injectable()
export class DemoOAuthCrmConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'DEMO_OAUTH_CRM',
    category: 'CRM',
    name: 'Demo CRM (OAuth 2.0)',
    description: 'CRM simulator authorised with OAuth 2.0 + PKCE; pulls contacts as customers.',
    authType: 'OAUTH2',
    capabilities: ['PULL', 'INCREMENTAL_SYNC', 'TEST_CONNECTION', 'REFRESH_CREDENTIALS'],
    entities: ['customers'],
    configSchema: z.object({
      clientId: z.string().min(3).max(200),
      fixture: z
        .object({ contacts: z.array(z.record(z.string(), z.unknown())).max(500).optional() })
        .optional(),
    }),
    credentialFields: [{ key: 'apiKey', label: 'Client secret', required: false }],
    oauth: {
      authorizeUrl: 'https://demo-crm.invalid/oauth/authorize',
      tokenUrl: 'https://demo-crm.invalid/oauth/token',
      scopes: ['contacts.read'],
      pkce: true,
      extraAuthorizeParams: { access_type: 'offline' },
    },
    defaultMappings: {
      customers: [
        {
          target: 'code',
          source: 'id',
          transforms: [{ name: 'template', arg: 'CRM-{value}' }, { name: 'upper' }],
          required: true,
        },
        {
          target: 'name',
          source: 'properties.company',
          transforms: [{ name: 'trim' }],
          required: true,
        },
        { target: 'email', source: 'properties.email', transforms: [{ name: 'lower' }] },
        { target: 'contactPerson', source: 'properties.owner', transforms: [] },
      ],
    },
    demo: true,
  };

  override async connect(ctx: ConnectorContext): Promise<ConnectResult> {
    if (!ctx.secrets.oauth?.accessToken)
      throw new IntegrationError('AUTHENTICATION_ERROR', 'Authorise the CRM through OAuth first.', {
        httpStatus: 401,
      });
    return { ok: true, message: 'CRM token accepted' };
  }

  async exchangeAuthorizationCode(
    _ctx: ConnectorContext,
    input: { code: string },
  ): Promise<OAuthTokens> {
    if (!input.code.startsWith('demo-code-'))
      throw new IntegrationError('AUTHENTICATION_ERROR', 'invalid_grant', { httpStatus: 400 });
    return {
      accessToken: `demo-access-${randomBytes(12).toString('hex')}`,
      refreshToken: `demo-refresh-${randomBytes(12).toString('hex')}`,
      expiresInSeconds: 3600,
      tokenType: 'Bearer',
      scope: 'contacts.read',
      externalAccountId: 'crm-portal-1',
    };
  }

  async refreshAccessToken(_ctx: ConnectorContext, refreshToken: string): Promise<OAuthTokens> {
    if (!refreshToken.startsWith('demo-refresh-'))
      throw new IntegrationError('AUTHENTICATION_ERROR', 'invalid_grant', { httpStatus: 401 });
    return {
      accessToken: `demo-access-${randomBytes(12).toString('hex')}`,
      refreshToken,
      expiresInSeconds: 3600,
      tokenType: 'Bearer',
    };
  }

  async revokeTokens(): Promise<void> {
    /* the demo provider forgets tokens immediately */
  }

  async refreshCredentials(ctx: ConnectorContext) {
    if (!ctx.secrets.oauth?.refreshToken) return null;
    const t = await this.refreshAccessToken(ctx, ctx.secrets.oauth.refreshToken);
    return {
      oauth: {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: new Date(Date.now() + (t.expiresInSeconds ?? 0) * 1000).toISOString(),
        tokenType: t.tokenType,
      },
    };
  }

  override async pull(ctx: ConnectorContext, req: PullRequest): Promise<PullResult> {
    const token = ctx.secrets.oauth?.accessToken;
    if (!token || !token.startsWith('demo-access-'))
      throw new IntegrationError('AUTHENTICATION_ERROR', 'CRM access token missing or expired.', {
        httpStatus: 401,
      });
    if (req.entity !== 'customers') return { records: [], nextCursor: null, hasMore: false };
    return pageFromFixture(toRecords(fixtureArray(ctx.config, 'contacts')), req.cursor, req.limit);
  }
}
