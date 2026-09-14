import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { COOKIES } from '@accounting/config';
import { changePasswordSchema, loginSchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { UnauthenticatedError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { AppConfigService } from '@/config/app-config.service';
import { clearAuthCookies, setAuthCookies } from './auth-cookies';
import { AuthService } from './auth.service';

class LoginDto extends createZodDto(loginSchema) {}
class ChangePasswordDto extends createZodDto(changePasswordSchema) {}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Authenticate with email and password; sets httpOnly cookies' })
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(body);
    setAuthCookies(res, this.config, result.tokens);
    return {
      user: result.user,
      accessToken: result.tokens.accessToken,
      expiresIn: this.config.env.JWT_ACCESS_TTL_SECONDS,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token =
      req.cookies?.[COOKIES.REFRESH_TOKEN] ??
      (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    if (typeof token !== 'string' || token.length === 0) {
      clearAuthCookies(res, this.config);
      throw new UnauthenticatedError('No refresh token.', ErrorCodes.SESSION_EXPIRED);
    }
    try {
      const result = await this.auth.refresh(token);
      setAuthCookies(res, this.config, result.tokens);
      return {
        user: result.user,
        accessToken: result.tokens.accessToken,
        expiresIn: this.config.env.JWT_ACCESS_TTL_SECONDS,
      };
    } catch (err) {
      clearAuthCookies(res, this.config);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @ApiCookieAuth()
  async logout(@CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user);
    clearAuthCookies(res, this.config);
  }

  @Get('me')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Current user, permissions for the active company, accessible companies',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user);
  }

  @Post('change-password')
  @HttpCode(204)
  @ApiCookieAuth()
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() body: ChangePasswordDto) {
    await this.auth.changePassword(user, body);
  }
}
