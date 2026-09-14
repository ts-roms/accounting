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
