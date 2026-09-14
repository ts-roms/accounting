import { Module } from '@nestjs/common';
import { DelegationsModule } from '@/modules/delegations/delegations.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { DimensionsController } from './dimensions/dimensions.controller';
import { DimensionsService } from './dimensions/dimensions.service';
import { FiscalPeriodsController } from './fiscal/fiscal-periods.controller';
import { FiscalPeriodsService } from './fiscal/fiscal-periods.service';
import { JournalEntriesController } from './journals/journal-entries.controller';
import { JournalEntriesService } from './journals/journal-entries.service';
import { AccountingPostingService } from './journals/posting.service';
import { GeneralLedgerController } from './ledger/general-ledger.controller';
import { GeneralLedgerService } from './ledger/general-ledger.service';
import { DocumentNumberingService } from './numbering/document-numbering.service';

/**
 * Accounting core: chart of accounts, fiscal calendar, journal documents, the
 * posting engine and the general-ledger read model. Other modules depend on
 * `AccountingPostingService` and `AccountsService.resolveMapped` only.
 */
@Module({
  imports: [RbacModule, WorkflowsModule, DelegationsModule],
  controllers: [
    AccountsController,
    FiscalPeriodsController,
    JournalEntriesController,
    GeneralLedgerController,
    DimensionsController,
  ],
  providers: [
    AccountsService,
    FiscalPeriodsService,
    JournalEntriesService,
    AccountingPostingService,
    GeneralLedgerService,
    DocumentNumberingService,
    DimensionsService,
  ],
  exports: [
    AccountsService,
    FiscalPeriodsService,
    AccountingPostingService,
    GeneralLedgerService,
    DocumentNumberingService,
    DimensionsService,
  ],
})
export class AccountingModule {}
