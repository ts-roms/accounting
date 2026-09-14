import { VersioningType, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { API_VERSION, HEADERS } from '@accounting/config';
import { AppConfigService } from './config/app-config.service';

/**
 * Applies the HTTP middleware stack. Shared by `main.ts` and the e2e tests so
 * tests run through the exact same prefix/versioning/cookie/CORS configuration.
 */
export function configureApp(app: INestApplication): AppConfigService {
  const config = app.get(AppConfigService);
  const express = app as NestExpressApplication;

  // Behind a reverse proxy (Next.js rewrite, nginx) so req.ip reflects the client.
  if (typeof express.set === 'function') {
    express.set('trust proxy', 1);
    express.disable('x-powered-by');
  }

  app.use(helmet({ contentSecurityPolicy: config.isProduction ? undefined : false }));
  app.use(cookieParser());
  app.enableCors({
    origin: config.env.API_CORS_ORIGINS,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      HEADERS.COMPANY_ID,
      HEADERS.CORRELATION_ID,
      HEADERS.REQUESTED_WITH,
      HEADERS.IDEMPOTENCY_KEY,
    ],
    exposedHeaders: [HEADERS.CORRELATION_ID],
  });

  app.setGlobalPrefix(config.env.API_GLOBAL_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION.replace('v', '') });
  app.enableShutdownHooks();
  return config;
}
