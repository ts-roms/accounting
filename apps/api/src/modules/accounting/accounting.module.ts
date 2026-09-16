import { Module } from '@nestjs/common';
import { DelegationsModule } from '@/modules/delegations/delegations.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import {
  DimensionRulesController,
  PostingRulesController,
  PrepaymentsController,
  RecurringJournalsController,
  SuspenseController,
} from './accounting-core.controller';
import { AccountingSchedulesJob } from './accounting-schedules.job';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsService } from './accounts/accounts.service';
import { DimensionRulesService } from './dimensions/dimension-rules.service';
import { DimensionsController } from './dimensions/dimensions.controller';
import { DimensionsService } from './dimensions/dimensions.service';
import { FiscalPeriodsController } from './fiscal/fiscal-periods.controller';
import { NumberingController } from './numbering/numbering.controller';
import { FiscalPeriodsService } from './fiscal/fiscal-periods.service';
import { JournalEntriesController } from './journals/journal-entries.controller';
import { JournalEntriesService } from './journals/journal-entries.service';
import { AccountingPostingService } from './journals/posting.service';
import { GeneralLedgerController } from './ledger/general-ledger.controller';
import { GeneralLedgerService } from './ledger/general-ledger.service';
import { DocumentNumberingService } from './numbering/document-numbering.service';
import { PostingRulesService } from './posting-rules/posting-rules.service';
import { PrepaymentsService } from './prepayments/prepayments.service';
import { RecurringJournalsService } from './recurring/recurring-journals.service';
import { SuspenseService } from './suspense/suspense.service';

/**
 * Accounting core: chart of accounts, fiscal calendar, journal documents, the
 * posting engine, the general-ledger read model, recurring journals,
 * prepayments, posting rules, dimension rules and the suspense monitor.
 * Other modules depend on `AccountingPostingService`,
 * `AccountsService.resolveMapped` and `PostingRulesService.resolve` only.
 */
@Module({
  imports: [RbacModule, WorkflowsModule, DelegationsModule, JobsModule],
  controllers: [
    AccountsController,
    FiscalPeriodsController,
    NumberingController,
    JournalEntriesController,
    GeneralLedgerController,
    DimensionsController,
    DimensionRulesController,
    RecurringJournalsController,
    PrepaymentsController,
    PostingRulesController,
    SuspenseController,
  ],
  providers: [
    AccountsService,
    FiscalPeriodsService,
    JournalEntriesService,
    AccountingPostingService,
    GeneralLedgerService,
    DocumentNumberingService,
    DimensionsService,
    DimensionRulesService,
    RecurringJournalsService,
    PrepaymentsService,
    PostingRulesService,
    SuspenseService,
    AccountingSchedulesJob,
  ],
  exports: [
    AccountsService,
    JournalEntriesService,
    FiscalPeriodsService,
    AccountingPostingService,
    GeneralLedgerService,
    DocumentNumberingService,
    DimensionsService,
    DimensionRulesService,
    PostingRulesService,
    RecurringJournalsService,
    PrepaymentsService,
    SuspenseService,
  ],
})
export class AccountingModule {}
