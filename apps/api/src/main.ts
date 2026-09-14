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

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
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

  await app.listen(config.env.API_PORT, config.env.API_HOST);
  logger.log(
    `API listening on http://${config.env.API_HOST}:${config.env.API_PORT}/${config.env.API_GLOBAL_PREFIX}/${API_VERSION}`,
  );
}

bootstrap().catch((err) => {
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
