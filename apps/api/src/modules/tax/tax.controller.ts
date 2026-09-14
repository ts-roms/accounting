import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  createTaxCodeSchema,
  listTaxCodesQuerySchema,
  listTaxTransactionsQuerySchema,
  taxReportQuerySchema,
  updateTaxCodeSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { TaxCodesService } from './tax-codes.service';
import { TaxReportsService } from './tax-reports.service';

class CreateTaxCodeDto extends createZodDto(createTaxCodeSchema) {}
class UpdateTaxCodeDto extends createZodDto(updateTaxCodeSchema) {}
class ListTaxCodesQueryDto extends createZodDto(listTaxCodesQuerySchema) {}
class ListTaxTransactionsQueryDto extends createZodDto(listTaxTransactionsQuerySchema) {}
class TaxReportQueryDto extends createZodDto(taxReportQuerySchema) {}

@ApiTags('Tax')
@Controller('tax')
@CompanyScoped()
export class TaxController {
  constructor(
    private readonly codes: TaxCodesService,
    private readonly reports: TaxReportsService,
  ) {}

  @Get('codes')
  @RequirePermissions(P['tax.view'])
  listCodes(@CurrentUser() user: AuthenticatedUser, @Query() query: ListTaxCodesQueryDto) {
    return this.codes.list(user.companyId!, query);
  }

  @Get('codes/:id')
  @RequirePermissions(P['tax.view'])
  getCode(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.codes.get(user.companyId!, id);
  }

  @Post('codes')
  @RequirePermissions(P['tax.manage'])
  createCode(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateTaxCodeDto) {
    return this.codes.create(user.companyId!, user, body);
  }

  @Patch('codes/:id')
  @RequirePermissions(P['tax.manage'])
  updateCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTaxCodeDto,
  ) {
    return this.codes.update(user.companyId!, user, id, body);
  }

  @Get('transactions')
  @RequirePermissions(P['tax.view'])
  transactions(@CurrentUser() user: AuthenticatedUser, @Query() query: ListTaxTransactionsQueryDto) {
    return this.reports.transactions(user.companyId!, query);
  }

  @Get('reports/summary')
  @RequirePermissions(P['tax.view'])
  @ApiOperation({ summary: 'Base and tax per code and side; output - input = net payable' })
  summary(@CurrentUser() user: AuthenticatedUser, @Query() query: TaxReportQueryDto) {
    return this.reports.summary(user.companyId!, query);
  }

  @Get('reports/withholding')
  @RequirePermissions(P['tax.view'])
  @ApiOperation({ summary: 'Withholding grouped by counterparty and rate' })
  withholding(@CurrentUser() user: AuthenticatedUser, @Query() query: TaxReportQueryDto) {
    return this.reports.withholdingByParty(user.companyId!, query);
  }
}
