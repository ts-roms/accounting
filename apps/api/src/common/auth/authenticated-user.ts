import type { DelegatedGrant } from '@accounting/types';

/**
 * The principal attached to `request.user` after authentication. Permissions
 * are resolved for the active company (union of organization-wide and
 * company-scoped role assignments).
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  organizationId: string;
  sessionId: string;
  /** Company selected through X-Company-Id, if any. */
  companyId?: string;
  permissions: ReadonlySet<string>;
  roleKeys: readonly string[];
  /**
   * Set only on the scheduler principal: automated postings (depreciation,
   * recurring journals) are gated by configuration, not per-user permissions.
   */
  system?: boolean;
  /**
   * Set when the request was authenticated with an API key instead of a
   * session: the principal is the key's owner, restricted to the key's scopes
   * (permissions = scope permissions intersected with the owner's).
   */
  apiKeyId?: string;
  scopes?: readonly string[];
  /** Set when a sync / webhook job acts on behalf of an integration. */
  integrationId?: string;
  /**
   * Active delegations lending this user approval authority in the active
   * company. `permissions` stays the user's own; the permission guard also
   * accepts a permission present here, and services call
   * `AuthorityService.assert` to enforce scope, amount and SoD per document.
   */
  delegations?: readonly DelegatedGrant[];
}

export interface AccessTokenPayload {
  /** user id */
  sub: string;
  /** session id */
  sid: string;
  /** organization id */
  org: string;
  iat?: number;
  exp?: number;
}
