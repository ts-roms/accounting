import './config/load-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { API_VERSION } from '@accounting/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { DRIZZLE, type Database } from './database/database.types';
import { schemaBehindMessage, schemaStatus } from './database/schema-status';

async function bootstrap(): Promise<void> {
  // rawBody: inbound webhook signatures are verified over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = configureApp(app);

  if (!config.isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Enterprise Accounting API')
      .setDescription(
        'Modular-monolith accounting platform. All monetary values are decimal strings.',
      )
      .setVersion('0.1.0')
      .addCookieAuth('acct_access')
      .addBearerAuth()
      .build();
    const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig));
    SwaggerModule.setup(`${config.env.API_GLOBAL_PREFIX}/docs`, app, document, {
      jsonDocumentUrl: `${config.env.API_GLOBAL_PREFIX}/docs-json`,
    });
  }

  // Say it once at boot: a database behind the build would otherwise surface as
  // "relation does not exist" in every job and request that touches the new tables.
  try {
    const status = await schemaStatus(app.get<Database>(DRIZZLE));
    if (status.pending.length) logger.warn(schemaBehindMessage(status), 'Bootstrap');
  } catch (err) {
    logger.warn(`Could not read the migration state: ${(err as Error).message}`, 'Bootstrap');
  }

  await app.listen(config.env.API_PORT, config.env.API_HOST);
  logger.log(
    `API listening on http://${config.env.API_HOST}:${config.env.API_PORT}/${config.env.API_GLOBAL_PREFIX}/${API_VERSION}`,
  );
}

bootstrap().catch((err) => {
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
