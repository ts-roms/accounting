import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context propagated through AsyncLocalStorage so deep services
 * (audit, logging) can read who is acting without threading arguments through
 * every call. Populated by RequestContextMiddleware and enriched by the auth
 * guard once the user is known.
 */
export interface RequestContextData {
  correlationId: string;
  ipAddress?: string;
  userAgent?: string;
  userId?: string;
  userEmail?: string;
  organizationId?: string;
  /** Active company selected via the X-Company-Id header (validated). */
  companyId?: string;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<RequestContextData>();

export const RequestContext = {
  run<T>(data: RequestContextData, fn: () => T): T {
    return storage.run(data, fn);
  },
  get(): RequestContextData | undefined {
    return storage.getStore();
  },
  /** Mutates the current store; a no-op outside a request scope. */
  patch(partial: Partial<RequestContextData>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, partial);
  },
};
