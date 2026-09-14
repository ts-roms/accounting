import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import type { AccessTokenPayload } from '@/common/auth/authenticated-user';
import { AppConfigService } from '@/config/app-config.service';

/**
 * Access tokens are short-lived signed JWTs (HS256). Refresh tokens are opaque
 * random strings; only their SHA-256 digest is persisted so a database leak
 * does not yield usable sessions.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  signAccessToken(payload: Omit<AccessTokenPayload, 'iat' | 'exp'>): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.config.env.JWT_ACCESS_SECRET,
      expiresIn: this.config.env.JWT_ACCESS_TTL_SECONDS,
      issuer: 'accounting-api',
      audience: 'accounting-web',
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
    try {
      return await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.env.JWT_ACCESS_SECRET,
        issuer: 'accounting-api',
        audience: 'accounting-web',
      });
    } catch {
      return null;
    }
  }

  generateRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  get accessTtlSeconds(): number {
    return this.config.env.JWT_ACCESS_TTL_SECONDS;
  }

  get refreshTtlSeconds(): number {
    return this.config.env.REFRESH_TOKEN_TTL_SECONDS;
  }
}
