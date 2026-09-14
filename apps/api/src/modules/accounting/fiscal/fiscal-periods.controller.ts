import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import { createFiscalYearSchema, periodActionSchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { FiscalPeriodsService } from './fiscal-periods.service';

class CreateFiscalYearDto extends createZodDto(createFiscalYearSchema) {}
class PeriodActionDto extends createZodDto(periodActionSchema) {}

@ApiTags('Fiscal Periods')
@Controller()
@CompanyScoped()
export class FiscalPeriodsController {
  constructor(private readonly service: FiscalPeriodsService) {}

  @Get('fiscal-years')
  @RequirePermissions(P['period.view'])
  @ApiOperation({ summary: 'Fiscal years with their periods, newest first' })
  listYears(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listYears(user.companyId!);
  }

  @Post('fiscal-years')
  @RequirePermissions(P['period.manage'])
  @ApiOperation({ summary: 'Create a fiscal year of 12 monthly periods' })
  createYear(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateFiscalYearDto) {
    return this.service.createYear(user.companyId!, body);
  }

  @Post('fiscal-years/:id/close')
  @RequirePermissions(P['period.close'])
  @ApiOperation({
    summary: 'Year-end close: posts the closing entry to retained earnings and locks the year',
  })
  closeYear(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.closeYear(user.companyId!, id, user.id);
  }

  @Post('fiscal-periods/:id/close')
  @RequirePermissions(P['period.close'])
  closePeriod(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PeriodActionDto,
  ) {
    return this.service.closePeriod(user.companyId!, id, user.id, body.reason);
  }

  @Post('fiscal-periods/:id/reopen')
  @RequirePermissions(P['period.reopen'])
  reopenPeriod(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PeriodActionDto,
  ) {
    return this.service.reopenPeriod(user.companyId!, id, user.id, body.reason);
  }
}
