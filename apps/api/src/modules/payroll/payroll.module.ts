import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { FxModule } from '@/modules/fx/fx.module';
import { BankingModule } from '@/modules/banking/banking.module';
import { BudgetingModule } from '@/modules/budgeting/budgeting.module';
import { DelegationsModule } from '@/modules/delegations/delegations.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import { EmployeesService } from './employees.service';
import { PayRunsService } from './pay-runs.service';
import { PayrollConfigService } from './payroll-config.service';
import { PayrollReportsService } from './payroll-reports.service';
import { EmployeesController, PayrollController } from './payroll.controller';
import { PayrollRemindersJob } from './payroll.job';

/**
 * Payroll & employee expenses (Prompt #11): employee master, pay items,
 * pay runs (calculate / approve / post / pay / reverse), reimbursement of
 * posted expense claims through payroll, reports, integrity and reminders.
 */
@Module({
  imports: [
    AccountingModule,
    BankingModule,
    FxModule,
    BudgetingModule,
    DelegationsModule,
    WorkflowsModule,
    RbacModule,
    JobsModule,
  ],
  controllers: [EmployeesController, PayrollController],
  providers: [
    EmployeesService,
    PayrollConfigService,
    PayRunsService,
    PayrollReportsService,
    PayrollRemindersJob,
  ],
  exports: [EmployeesService, PayrollConfigService, PayRunsService, PayrollReportsService],
})
export class PayrollModule {}
