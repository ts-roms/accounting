import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { BankAccountsController, BankStatementsController, BankTransactionsController } from './banking.controller';
import { BankingService } from './banking.service';
import { StatementsService } from './statements.service';

/** Bank / cash accounts, direct bank transactions, statement import, matching and reconciliation. */
@Module({
  imports: [AccountingModule],
  controllers: [BankAccountsController, BankTransactionsController, BankStatementsController],
  providers: [BankingService, StatementsService],
  exports: [BankingService, StatementsService],
})
export class BankingModule {}
