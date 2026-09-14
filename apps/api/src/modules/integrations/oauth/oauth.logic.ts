import { createHash, randomBytes } from 'node:crypto';

/** Pure OAuth 2.0 helpers: state, PKCE and URL construction. */

export function generateState(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString('base64url');
}

export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

export function generateCodeVerifier(random: (n: number) => Buffer = randomBytes): string {
  return random(48).toString('base64url');
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export interface AuthorizeUrlInput {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge?: string;
  extra?: Record<string, string>;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  if (input.scopes.length) url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('state', input.state);
  if (input.codeChallenge) {
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(input.extra ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
}

export function parseTokenResponse(raw: unknown): TokenResponse {
  if (!raw || typeof raw !== 'object') throw new Error('Token response is not an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.access_token !== 'string' || r.access_token.length === 0)
    throw new Error('Token response has no access_token');
  return {
    access_token: r.access_token,
    refresh_token: typeof r.refresh_token === 'string' ? r.refresh_token : undefined,
    expires_in: typeof r.expires_in === 'number' ? r.expires_in : Number(r.expires_in) || undefined,
    token_type: typeof r.token_type === 'string' ? r.token_type : undefined,
    scope: typeof r.scope === 'string' ? r.scope : undefined,
    id_token: typeof r.id_token === 'string' ? r.id_token : undefined,
  };
}

/** Whether an access token should be refreshed now (with a safety margin). */
export function needsRefresh(
  expiresAt: Date | null | undefined,
  now = new Date(),
  marginMs = 5 * 60_000,
): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - now.getTime() <= marginMs;
}

/** Only same-origin / relative return paths are honoured to avoid open redirects. */
export function safeReturnTo(
  returnTo: string | null | undefined,
  webBaseUrl: string,
  fallback: string,
): string {
  if (!returnTo) return `${webBaseUrl}${fallback}`;
  if (returnTo.startsWith('/') && !returnTo.startsWith('//')) return `${webBaseUrl}${returnTo}`;
  try {
    const u = new URL(returnTo);
    const base = new URL(webBaseUrl);
    if (u.origin === base.origin) return u.toString();
  } catch {
    /* fall through */
  }
  return `${webBaseUrl}${fallback}`;
}
