import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  openingAssetsSchema,
  openingInventorySchema,
  openingReportQuerySchema,
  openingSubledgerSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { OpeningBalancesService } from './opening-balances.service';

class SubledgerDto extends createZodDto(openingSubledgerSchema) {}
class InventoryDto extends createZodDto(openingInventorySchema) {}
class AssetsDto extends createZodDto(openingAssetsSchema) {}
class ReportDto extends createZodDto(openingReportQuerySchema) {}

@ApiTags('Opening balances')
@Controller('opening-balances')
@CompanyScoped()
export class OpeningBalancesController {
  constructor(private readonly service: OpeningBalancesService) {}

  @Get('report')
  @RequirePermissions(P['opening-balance.view'])
  @ApiOperation({
    summary:
      'Opening balance reconciliation: control accounts vs subledgers, opening journals, equity residual',
  })
  report(@CurrentUser() user: AuthenticatedUser, @Query() query: ReportDto) {
    return this.service.report(user.companyId!, query.asOf, query.area);
  }

  @Post('subledger')
  @RequirePermissions(P['opening-balance.manage'])
  @ApiOperation({
    summary: 'Load AR or AP open items at the cut-over (posted against OPENING_BALANCE_EQUITY)',
  })
  subledger(@CurrentUser() user: AuthenticatedUser, @Body() body: SubledgerDto) {
    return this.service.loadSubledger(user.companyId!, user, body);
  }

  @Post('inventory')
  @RequirePermissions(P['opening-balance.manage'])
  @ApiOperation({ summary: 'Load opening stock (posted adjustment with reason OPENING)' })
  inventory(@CurrentUser() user: AuthenticatedUser, @Body() body: InventoryDto) {
    return this.service.loadInventory(user.companyId!, user, body);
  }

  @Post('assets')
  @RequirePermissions(P['opening-balance.manage'])
  @ApiOperation({ summary: 'Load migrated fixed assets with their accumulated depreciation' })
  assets(@CurrentUser() user: AuthenticatedUser, @Body() body: AssetsDto) {
    return this.service.loadAssets(user.companyId!, user, body);
  }
}
