import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { BankingModule } from '@/modules/banking/banking.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { PayablesModule } from '@/modules/payables/payables.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReceivablesModule } from '@/modules/receivables/receivables.module';
import { BankFeedIntegrityService } from './bank-feed-integrity.service';
import { BankFeedRulesService } from './bank-feed-rules.service';
import { BankFeedController } from './bank-feed.controller';
import { BankFeedSweepJob } from './bank-feed.job';
import { BankFeedService } from './bank-feed.service';

/**
 * Bank feed auto-reconciliation (Prompt #12): matching rules, the
 * suggestion engine (rules, open documents, history), the review queue,
 * KPIs, integrity and the daily sweep. Explaining a line always goes through
 * BankingService / CustomerPaymentsService / VendorPaymentsService.
 */
@Module({
  imports: [
    AccountingModule,
    BankingModule,
    ReceivablesModule,
    PayablesModule,
    RbacModule,
    JobsModule,
  ],
  controllers: [BankFeedController],
  providers: [BankFeedRulesService, BankFeedService, BankFeedIntegrityService, BankFeedSweepJob],
  exports: [BankFeedService, BankFeedRulesService, BankFeedIntegrityService],
})
export class BankFeedModule {}
