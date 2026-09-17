import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  createEmployeeSchema,
  createPayItemSchema,
  createPayRunSchema,
  employeePayItemSchema,
  employeeYtdQuerySchema,
  isoDateSchema,
  listEmployeesQuerySchema,
  listPayRunsQuerySchema,
  payPayRunSchema,
  payrollIntegrityQuerySchema,
  payrollSummaryQuerySchema,
  reversePayRunSchema,
  setPayRunInputsSchema,
  updateEmployeeSchema,
  updatePayItemSchema,
  updatePayrollSettingsSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { EmployeesService } from './employees.service';
import { PayRunsService } from './pay-runs.service';
import { PayrollConfigService } from './payroll-config.service';
import { PayrollReportsService } from './payroll-reports.service';
import { PayrollRemindersJob } from './payroll.job';

class CreateEmployeeDto extends createZodDto(createEmployeeSchema) {}
class UpdateEmployeeDto extends createZodDto(updateEmployeeSchema) {}
class ListEmployeesQueryDto extends createZodDto(listEmployeesQuerySchema) {}
class EmployeePayItemDto extends createZodDto(employeePayItemSchema) {}
class EmployeeYtdQueryDto extends createZodDto(employeeYtdQuerySchema) {}
class CreatePayItemDto extends createZodDto(createPayItemSchema) {}
class UpdatePayItemDto extends createZodDto(updatePayItemSchema) {}
class UpdatePayrollSettingsDto extends createZodDto(updatePayrollSettingsSchema) {}
class CreatePayRunDto extends createZodDto(createPayRunSchema) {}
class SetPayRunInputsDto extends createZodDto(setPayRunInputsSchema) {}
class ListPayRunsQueryDto extends createZodDto(listPayRunsQuerySchema) {}
class PayPayRunDto extends createZodDto(payPayRunSchema) {}
class ReversePayRunDto extends createZodDto(reversePayRunSchema) {}
class ReasonDto extends createZodDto(z.object({ reason: z.string().trim().min(1).max(500) })) {}
class SummaryQueryDto extends createZodDto(payrollSummaryQuerySchema) {}
class IntegrityQueryDto extends createZodDto(payrollIntegrityQuerySchema) {}
class AsOfDto extends createZodDto(z.object({ asOf: isoDateSchema.optional() })) {}

@ApiTags('Employees')
@Controller('employees')
@CompanyScoped()
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly reports: PayrollReportsService,
  ) {}

  @Get()
  @RequirePermissions(P['employee.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListEmployeesQueryDto) {
    return this.employees.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['employee.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.employees.get(user.companyId!, id);
  }

  @Get(':id/ytd')
  @RequirePermissions(P['payroll.view'])
  @ApiOperation({ summary: 'Year-to-date pay of one employee from posted / paid payslips' })
  ytd(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: EmployeeYtdQueryDto,
  ) {
    return this.reports.employeeYtd(user.companyId!, id, query);
  }

  @Post()
  @RequirePermissions(P['employee.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateEmployeeDto) {
    return this.employees.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['employee.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateEmployeeDto,
  ) {
    return this.employees.update(user.companyId!, user, id, body);
  }

  @Post(':id/pay-items')
  @RequirePermissions(P['employee.manage'])
  @ApiOperation({ summary: 'Assign a recurring pay item (allowance, loan, opt-in contribution)' })
  addPayItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EmployeePayItemDto,
  ) {
    return this.employees.addPayItem(user.companyId!, user, id, body);
  }

  @Delete(':id/pay-items/:assignmentId')
  @RequirePermissions(P['employee.manage'])
  removePayItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.employees.removePayItem(user.companyId!, user, id, assignmentId);
  }
}

/**
 * Payroll (Prompt #11): pay items and settings are data; pay runs are the
 * only path from salaries to the ledger and from the employee payable to
 * the bank.
 */
@ApiTags('Payroll')
@Controller('payroll')
@CompanyScoped()
export class PayrollController {
  constructor(
    private readonly config: PayrollConfigService,
    private readonly runs: PayRunsService,
    private readonly reports: PayrollReportsService,
    private readonly reminders: PayrollRemindersJob,
  ) {}

  // ----------------------------------------------------------------- settings

  @Get('settings')
  @RequirePermissions(P['payroll.view'])
  settings(@CurrentUser() user: AuthenticatedUser) {
    return this.config.settings(user.companyId!);
  }

  @Put('settings')
  @RequirePermissions(P['payroll.manage'])
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdatePayrollSettingsDto) {
    return this.config.updateSettings(user.companyId!, user, body);
  }

  // ---------------------------------------------------------------- pay items

  @Get('pay-items')
  @RequirePermissions(P['payroll.view'])
  listPayItems(@CurrentUser() user: AuthenticatedUser) {
    return this.config.listPayItems(user.companyId!);
  }

  @Post('pay-items')
  @RequirePermissions(P['payroll.manage'])
  @ApiOperation({
    summary: 'Create a pay item (earning, deduction, withholding brackets, employer contribution)',
  })
  createPayItem(@CurrentUser() user: AuthenticatedUser, @Body() body: CreatePayItemDto) {
    return this.config.createPayItem(user.companyId!, user, body);
  }

  @Patch('pay-items/:id')
  @RequirePermissions(P['payroll.manage'])
  updatePayItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePayItemDto,
  ) {
    return this.config.updatePayItem(user.companyId!, user, id, body);
  }

  // ----------------------------------------------------------------- pay runs

  @Get('runs')
  @RequirePermissions(P['payroll.view'])
  listRuns(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPayRunsQueryDto) {
    return this.runs.list(user.companyId!, query);
  }

  @Get('runs/:id')
  @RequirePermissions(P['payroll.view'])
  @ApiOperation({ summary: 'Pay run with payslips, lines and one-off inputs' })
  getRun(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.get(user.companyId!, id);
  }

  @Get('payslips/:id')
  @RequirePermissions(P['payroll.view'])
  getPayslip(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.payslip(user.companyId!, id);
  }

  @Post('runs')
  @RequirePermissions(P['payroll.manage'])
  createRun(@CurrentUser() user: AuthenticatedUser, @Body() body: CreatePayRunDto) {
    return this.runs.create(user.companyId!, user, body);
  }

  @Put('runs/:id/inputs')
  @RequirePermissions(P['payroll.manage'])
  @ApiOperation({
    summary:
      'Replace the run’s one-off inputs (overtime, bonus, unpaid leave); recalculate afterwards',
  })
  setInputs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetPayRunInputsDto,
  ) {
    return this.runs.setInputs(user.companyId!, user, id, body);
  }

  @Post('runs/:id/calculate')
  @HttpCode(200)
  @RequirePermissions(P['payroll.manage'])
  @ApiOperation({
    summary: 'Build the payslips from employees, assignments, inputs and posted expense claims',
  })
  calculate(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.calculate(user.companyId!, user, id);
  }

  @Post('runs/:id/submit')
  @HttpCode(200)
  @RequirePermissions(P['payroll.manage'])
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.submit(user.companyId!, user, id);
  }

  @Post('runs/:id/approve')
  @HttpCode(200)
  @RequirePermissions(P['payroll.approve'])
  @ApiOperation({
    summary:
      'Four-eyes approval (delegable; SoD against the preparer; workflow-gated when configured)',
  })
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.approve(user.companyId!, user, id);
  }

  @Post('runs/:id/reopen')
  @HttpCode(200)
  @RequirePermissions(P['payroll.approve'])
  reopen(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return this.runs.reopen(user.companyId!, user, id, body.reason);
  }

  @Post('runs/:id/post')
  @HttpCode(200)
  @RequirePermissions(P['payroll.post'])
  @ApiOperation({ summary: 'Post the payroll journal dated on the period end' })
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.post(user.companyId!, user, id);
  }

  @Post('runs/:id/pay')
  @HttpCode(200)
  @RequirePermissions(P['payroll.post'])
  @ApiOperation({ summary: 'Pay the net (and reimbursed claims) from a bank account' })
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PayPayRunDto,
  ) {
    return this.runs.pay(user.companyId!, user, id, body);
  }

  @Post('runs/:id/reverse')
  @HttpCode(200)
  @RequirePermissions(P['payroll.post'])
  reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReversePayRunDto,
  ) {
    return this.runs.reverse(user.companyId!, user, id, body);
  }

  @Delete('runs/:id')
  @HttpCode(204)
  @RequirePermissions(P['payroll.manage'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.runs.remove(user.companyId!, user, id);
  }

  // ------------------------------------------------------------------ reports

  @Get('reports/summary')
  @RequirePermissions(P['payroll.view'])
  @ApiOperation({
    summary: 'Payroll cost for a window: totals, by department, by pay item, by month',
  })
  summary(@CurrentUser() user: AuthenticatedUser, @Query() query: SummaryQueryDto) {
    return this.reports.summary(user.companyId!, query);
  }

  @Get('reports/withholding')
  @RequirePermissions(P['payroll.view'])
  @ApiOperation({ summary: 'Withholding tax remittance by month' })
  withholding(@CurrentUser() user: AuthenticatedUser, @Query() query: SummaryQueryDto) {
    return this.reports.withholdingRemittance(user.companyId!, query);
  }

  @Get('integrity')
  @RequirePermissions(P['payroll.view'])
  integrity(@CurrentUser() user: AuthenticatedUser, @Query() query: IntegrityQueryDto) {
    return this.reports.integrity(
      user.companyId!,
      query.asOf ?? new Date().toISOString().slice(0, 10),
    );
  }

  @Post('reminders/run')
  @HttpCode(200)
  @RequirePermissions(P['payroll.manage'])
  @ApiOperation({ summary: 'Run the pay-date reminder job now' })
  runReminders(@Query() query: AsOfDto) {
    return this.reminders.run(query.asOf);
  }
}
