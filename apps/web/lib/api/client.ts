import { API_BASE_PATH, HEADERS, REQUESTED_WITH_VALUE } from '@accounting/config';
import type { ApiErrorBody } from '@accounting/types';

/**
 * Browser-side API client. Requests go to the same origin (`/api/v1/...`) and
 * Next.js proxies them to the NestJS backend, so the httpOnly auth cookies are
 * sent automatically and no API secret exists on the client.
 *
 * - Adds the CSRF header on every state-changing request.
 * - Adds the active company header when one is selected.
 * - Transparently refreshes the session once on 401 and retries.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }

  get code(): string {
    return this.body.code;
  }
}

const COMPANY_STORAGE_KEY = 'acct.activeCompanyId';

export function getActiveCompanyId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(COMPANY_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setActiveCompanyId(companyId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (companyId) window.localStorage.setItem(COMPANY_STORAGE_KEY, companyId);
    else window.localStorage.removeItem(COMPANY_STORAGE_KEY);
  } catch {
    /* storage unavailable - company selection simply will not persist */
  }
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE_PATH}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { [HEADERS.REQUESTED_WITH]: REQUESTED_WITH_VALUE },
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export interface RequestOptions extends Omit<RequestInit, 'body' | 'headers'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** Skip the automatic refresh-and-retry (used by the refresh call itself). */
  noRetry?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = path.startsWith('http')
    ? path
    : `${API_BASE_PATH}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, headers = {}, noRetry, ...init } = options;
  const method = (init.method ?? 'GET').toUpperCase();

  const finalHeaders: Record<string, string> = { Accept: 'application/json', ...headers };
  if (method !== 'GET' && method !== 'HEAD')
    finalHeaders[HEADERS.REQUESTED_WITH] = REQUESTED_WITH_VALUE;
  const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !multipart) finalHeaders['Content-Type'] = 'application/json';
  const companyId = getActiveCompanyId();
  if (companyId && !(HEADERS.COMPANY_ID in finalHeaders))
    finalHeaders[HEADERS.COMPANY_ID] = companyId;

  const execute = () =>
    fetch(buildUrl(path, query), {
      ...init,
      method,
      credentials: 'include',
      headers: finalHeaders,
      body: body === undefined ? undefined : multipart ? (body as FormData) : JSON.stringify(body),
    });

  let response = await execute();
  if (response.status === 401 && !noRetry && !path.startsWith('/auth/login')) {
    const refreshed = await refreshSession();
    if (refreshed) response = await execute();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    // Not the API's JSON envelope: the dev proxy answers with a bare
    // "Internal Server Error" / 502 while the API is down or still starting.
    throw new ApiError(response.status, {
      code: 'API_UNAVAILABLE',
      message: response.ok
        ? 'The API returned an unexpected response.'
        : 'The API is not reachable - it may still be starting. Retry in a moment.',
    });
  }
  if (!response.ok) {
    const errorBody = (data as ApiErrorBody | undefined) ?? {
      code: 'HTTP_ERROR',
      message: response.statusText || 'Request failed',
    };
    throw new ApiError(response.status, errorBody);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};

/** Human-readable message for toasts; falls back to a generic message for unknown errors. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'VALIDATION_FAILED') {
      const issues =
        (err.body.details?.issues as Array<{ path?: string[]; message?: string }> | undefined) ??
        [];
      const first = issues[0];
      return first
        ? `${first.path?.join('.') ?? 'input'}: ${first.message ?? 'invalid'}`
        : err.message;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
