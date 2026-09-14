import type { PermissionKey, SyncEntity } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import type { Integration } from '@/database/schema';
import type { ExternalRecord } from '../../core/connector';
import { IntegrationError } from '../../core/integration-error';

export interface ImportContext {
  integration: Integration;
  /** The integration's owner narrowed to its scopes (see IntegrationPrincipalService). */
  principal: AuthenticatedUser;
  companyId: string;
  provider: string;
  correlationId: string;
}

export type ImportAction = 'CREATED' | 'UPDATED' | 'SKIPPED';

export interface ImportOutcome {
  action: ImportAction;
  internalId?: string;
  documentNumber?: string;
  message?: string;
}

/**
 * An importer is the *only* bridge from an external record to the domain: it
 * validates the mapped input with the same Zod schema the REST API uses and
 * calls the same service. It never touches journal tables.
 */
export interface Importer {
  readonly entity: SyncEntity;
  import(
    ctx: ImportContext,
    record: ExternalRecord,
    mapped: Record<string, unknown>,
  ): Promise<ImportOutcome>;
}

/** Scope enforcement for jobs: the guard is not on this path, so importers check explicitly. */
export function assertScope(ctx: ImportContext, ...permissions: PermissionKey[]): void {
  const missing = permissions.filter((p) => !ctx.principal.permissions.has(p));
  if (missing.length)
    throw new IntegrationError(
      'AUTHORIZATION_ERROR',
      `The integration lacks the scope for ${missing.join(', ')}.`,
      { details: { missing } },
    );
}

/** Stable idempotency key for domain writes that support one. */
export function domainIdempotencyKey(
  ctx: ImportContext,
  entity: string,
  externalId: string,
): string {
  return `int:${ctx.integration.id.slice(0, 8)}:${entity}:${externalId}`.slice(0, 100);
}
