import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  balanceSheetQuerySchema,
  incomeStatementQuerySchema,
  trialBalanceQuerySchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ReportingService } from './reporting.service';

class TrialBalanceQueryDto extends createZodDto(trialBalanceQuerySchema) {}
class IncomeStatementQueryDto extends createZodDto(incomeStatementQuerySchema) {}
class BalanceSheetQueryDto extends createZodDto(balanceSheetQuerySchema) {}

@ApiTags('Reports')
@Controller('reports')
@CompanyScoped()
export class ReportingController {
  constructor(private readonly service: ReportingService) {}

  @Get('trial-balance')
  @RequirePermissions(P['reports.view'])
  @ApiOperation({ summary: 'Trial balance: opening, movement and closing per account' })
  trialBalance(@CurrentUser() user: AuthenticatedUser, @Query() query: TrialBalanceQueryDto) {
    return this.service.trialBalance(user.companyId!, query);
  }

  @Get('income-statement')
  @RequirePermissions(P['reports.view'])
  incomeStatement(@CurrentUser() user: AuthenticatedUser, @Query() query: IncomeStatementQueryDto) {
    return this.service.incomeStatement(user.companyId!, query);
  }

  @Get('balance-sheet')
  @RequirePermissions(P['reports.view'])
  balanceSheet(@CurrentUser() user: AuthenticatedUser, @Query() query: BalanceSheetQueryDto) {
    return this.service.balanceSheet(user.companyId!, query);
  }
}
