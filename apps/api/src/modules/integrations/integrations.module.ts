import { Module, type OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR, ModuleRef } from '@nestjs/core';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { BankingModule } from '@/modules/banking/banking.module';
import { InventoryModule } from '@/modules/inventory/inventory.module';
import { PayablesModule } from '@/modules/payables/payables.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReceivablesModule } from '@/modules/receivables/receivables.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { CONNECTOR_CLASSES } from './connectors';
import { ConnectorRegistry } from './core/connector-registry';
import { CredentialsService } from './core/credentials.service';
import { IntegrationPrincipalService } from './core/integration-principal.service';
import { IntegrationsController } from './core/integrations.controller';
import { IntegrationsService } from './core/integrations.service';
import { IntegrationHealthService } from './health/integration-health.service';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { IdempotencyService } from './idempotency/idempotency.service';
import { IntegrationCleanupJob } from './jobs/integration-cleanup.job';
import { DeadLettersService } from './ops/dead-letters.service';
import { IntegrationOpsController } from './ops/integration-ops.controller';
import { IntegrationRetentionService } from './ops/integration-retention.service';
import { IntegrationLogsController } from './logs/integration-logs.controller';
import { IntegrationLogsService } from './logs/integration-logs.service';
import { ExternalReferencesService } from './mapping/external-references.service';
import { MappingsService } from './mapping/mappings.service';
import { NotificationsModule } from './notifications/notifications.module';
import { OAuthService } from './oauth/oauth.service';
import { BillsExporter, InvoicesExporter } from './sync/exporters/documents.exporter';
import {
  CustomersExporter,
  ProductsExporter,
  VendorsExporter,
} from './sync/exporters/parties.exporter';
import { BankTransactionsImporter } from './sync/importers/bank-transactions.importer';
import { BillsImporter } from './sync/importers/bills.importer';
import { ProductsImporter } from './sync/importers/products.importer';
import { VendorsImporter } from './sync/importers/vendors.importer';
import { CustomersImporter } from './sync/importers/customers.importer';
import { InvoicesImporter } from './sync/importers/invoices.importer';
import { PaymentsImporter } from './sync/importers/payments.importer';
import { SalesOrdersImporter } from './sync/importers/sales-orders.importer';
import { PurchaseOrdersImporter } from './sync/importers/purchase-orders.importer';
import { OrdersModule } from '@/modules/orders/orders.module';
import { PushTriggerService } from './sync/push-trigger.service';
import { RecordLinksService } from './sync/record-links.service';
import { SyncService } from './sync/sync.service';
import { InboundWebhooksService } from './webhooks/inbound-webhooks.service';
import { OutboundWebhooksService } from './webhooks/outbound-webhooks.service';
import { WebhooksController } from './webhooks/webhooks.controller';

/**
 * Integration platform (Prompt #4): connectors, registry, credentials, API
 * keys, OAuth, webhooks (in / out), outbox dispatch, sync engine, mapping,
 * external references, logs, health, idempotency and notifications.
 *
 * Boundary: this module depends on domain modules (receivables, banking,
 * accounting) only through their exported services; no domain module depends
 * on it (the outbox lives in its own global module).
 */
@Module({
  imports: [
    JobsModule,
    RbacModule,
    ApiKeysModule,
    NotificationsModule,
    AccountingModule,
    ReceivablesModule,
    OrdersModule,
    BankingModule,
    PayablesModule,
    InventoryModule,
  ],
  controllers: [
    IntegrationsController,
    IntegrationLogsController,
    WebhooksController,
    IntegrationOpsController,
  ],
  providers: [
    ...CONNECTOR_CLASSES,
    ConnectorRegistry,
    CredentialsService,
    IntegrationsService,
    IntegrationPrincipalService,
    IntegrationLogsService,
    MappingsService,
    ExternalReferencesService,
    CustomersImporter,
    InvoicesImporter,
    PaymentsImporter,
    BankTransactionsImporter,
    VendorsImporter,
    BillsImporter,
    ProductsImporter,
    SalesOrdersImporter,
    CustomersExporter,
    VendorsExporter,
    ProductsExporter,
    InvoicesExporter,
    BillsExporter,
    PurchaseOrdersImporter,
    SyncService,
    RecordLinksService,
    PushTriggerService,
    InboundWebhooksService,
    OutboundWebhooksService,
    OAuthService,
    IntegrationHealthService,
    IdempotencyService,
    IntegrationCleanupJob,
    IntegrationRetentionService,
    DeadLettersService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IntegrationsService, SyncService, OutboundWebhooksService, InboundWebhooksService],
})
export class IntegrationsModule implements OnModuleInit {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    for (const cls of CONNECTOR_CLASSES)
      this.registry.register(this.moduleRef.get(cls, { strict: false }));
  }
}
