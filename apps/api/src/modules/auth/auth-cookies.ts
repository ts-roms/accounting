import type { CookieOptions, Response } from 'express';
import { COOKIES } from '@accounting/config';
import type { AppConfigService } from '@/config/app-config.service';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

function baseOptions(config: AppConfigService): CookieOptions {
  return {
    httpOnly: true,
    secure: config.env.COOKIE_SECURE || config.isProduction,
    sameSite: 'lax',
    domain: config.env.COOKIE_DOMAIN,
    path: '/',
  };
}

export function setAuthCookies(
  res: Response,
  config: AppConfigService,
  tokens: IssuedTokens,
): void {
  const base = baseOptions(config);
  res.cookie(COOKIES.ACCESS_TOKEN, tokens.accessToken, {
    ...base,
    maxAge: config.env.JWT_ACCESS_TTL_SECONDS * 1000,
  });
  res.cookie(COOKIES.REFRESH_TOKEN, tokens.refreshToken, {
    ...base,
    maxAge: config.env.REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
}

export function clearAuthCookies(res: Response, config: AppConfigService): void {
  const base = baseOptions(config);
  res.clearCookie(COOKIES.ACCESS_TOKEN, base);
  res.clearCookie(COOKIES.REFRESH_TOKEN, base);
}
