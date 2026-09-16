import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { CsrfGuard } from './common/guards/csrf.guard';
import { AppConfigModule } from './config/app-config.module';
import { AppConfigService } from './config/app-config.service';
import { DatabaseModule } from './database/database.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { AiModule } from './modules/ai/ai.module';
import { IntegrityModule } from './modules/accounting/integrity/integrity.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { ControlsModule } from './modules/controls/controls.module';
import { FinancialCloseModule } from './modules/financial-close/financial-close.module';
import { AuditModule } from './modules/audit/audit.module';
import { DelegationsModule } from './modules/delegations/delegations.module';
import { ApiKeysModule } from './modules/integrations/api-keys/api-keys.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { OutboxModule } from './modules/integrations/events/outbox.module';
import { NotificationsModule } from './modules/integrations/notifications/notifications.module';
import { AuthModule } from './modules/auth/auth.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { BankingModule } from './modules/banking/banking.module';
import { BudgetingModule } from './modules/budgeting/budgeting.module';
import { ConsolidationModule } from './modules/consolidation/consolidation.module';
import { FxModule } from './modules/fx/fx.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { TaxModule } from './modules/tax/tax.module';
import { FixedAssetsModule } from './modules/fixed-assets/fixed-assets.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { PayablesModule } from './modules/payables/payables.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { ReceivablesModule } from './modules/receivables/receivables.module';
import { PermissionsGuard } from './modules/rbac/permissions.guard';
import { RbacModule } from './modules/rbac/rbac.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { SalesModule } from './modules/sales/sales.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.env.LOG_LEVEL,
          transport: config.isProduction
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true, colorize: true } },
          // Never log credentials or tokens.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.body.password',
              'req.body.currentPassword',
              'req.body.newPassword',
              'req.body.confirmPassword',
            ],
            censor: '[REDACTED]',
          },
          customProps: (req) => ({ correlationId: req.headers['x-correlation-id'] }),
          autoLogging: { ignore: (req) => (req.url ?? '').includes('/health') },
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [
          { ttl: config.env.RATE_LIMIT_TTL_SECONDS * 1000, limit: config.env.RATE_LIMIT_MAX },
        ],
      }),
    }),
    EventEmitterModule.forRoot({ wildcard: true }),
    DatabaseModule,
    AuditModule,
    OutboxModule,
    NotificationsModule,
    HealthModule,
    JobsModule,
    OrganizationsModule,
    RbacModule,
    UsersModule,
    AuthModule,
    AccountingModule,
    ReportingModule,
    ReceivablesModule,
    PayablesModule,
    SalesModule,
    PurchasingModule,
    InventoryModule,
    FixedAssetsModule,
    BankingModule,
    TaxModule,
    FxModule,
    ConsolidationModule,
    AiModule,
    ReconciliationModule,
    IntegrityModule,
    FinancialCloseModule,
    ControlsModule,
    WorkflowsModule,
    AttachmentsModule,
    BudgetingModule,
    DelegationsModule,
    ApiKeysModule,
    IntegrationsModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    // Guard order matters: rate limit -> CSRF -> authentication -> authorization.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
