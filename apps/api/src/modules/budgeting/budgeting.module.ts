import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { BankingModule } from '@/modules/banking/banking.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { TaxModule } from '@/modules/tax/tax.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import { BudgetsController, ExpenseClaimsController } from './budgeting.controller';
import { BudgetsService } from './budgets.service';
import { ExpenseClaimsService } from './expense-claims.service';

/** Budgets with versions and variance analysis; employee expense claims through approval, posting and payment. */
@Module({
  imports: [AccountingModule, RbacModule, TaxModule, BankingModule, WorkflowsModule],
  controllers: [BudgetsController, ExpenseClaimsController],
  providers: [BudgetsService, ExpenseClaimsService],
  exports: [ExpenseClaimsService],
})
export class BudgetingModule {}
