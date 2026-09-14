import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  createFxRevaluationSchema,
  isoDateSchema,
  listExchangeRatesQuerySchema,
  paginationQuerySchema,
  resolveRateQuerySchema,
  upsertExchangeRateSchema,
} from '@accounting/validation';
import { z } from 'zod';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ExchangeRatesService } from './exchange-rates.service';
import { FxService } from './fx.service';

class UpsertRateDto extends createZodDto(upsertExchangeRateSchema) {}
class ListRatesQueryDto extends createZodDto(listExchangeRatesQuerySchema) {}
class ResolveRateQueryDto extends createZodDto(resolveRateQuerySchema) {}
class CreateRevaluationDto extends createZodDto(createFxRevaluationSchema) {}
class PreviewQueryDto extends createZodDto(z.object({ asOfDate: isoDateSchema })) {}
class PageQueryDto extends createZodDto(paginationQuerySchema) {}

/** Organization-wide: rates are shared by every company of the organization. */
@ApiTags('Exchange Rates')
@Controller('exchange-rates')
export class ExchangeRatesController {
  constructor(private readonly rates: ExchangeRatesService) {}

  @Get()
  @RequirePermissions(P['exchange-rate.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListRatesQueryDto) {
    return this.rates.list(user.organizationId, query);
  }

  @Get('resolve')
  @RequirePermissions(P['exchange-rate.view'])
  @ApiOperation({ summary: 'Rate in force on a date (direct or inverted)' })
  async resolve(@CurrentUser() user: AuthenticatedUser, @Query() query: ResolveRateQueryDto) {
    return {
      ...query,
      rate: await this.rates.rateFor(
        user.organizationId,
        query.fromCurrency,
        query.toCurrency,
        query.onDate,
      ),
    };
  }

  @Put()
  @RequirePermissions(P['exchange-rate.manage'])
  upsert(@CurrentUser() user: AuthenticatedUser, @Body() body: UpsertRateDto) {
    return this.rates.upsert(user.organizationId, user, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['exchange-rate.manage'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.rates.remove(user.organizationId, user, id);
  }
}

@ApiTags('FX Revaluation')
@Controller('fx/revaluations')
@CompanyScoped()
export class FxRevaluationsController {
  constructor(private readonly fx: FxService) {}

  @Get()
  @RequirePermissions(P['exchange-rate.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: PageQueryDto) {
    return this.fx.list(user.companyId!, query);
  }

  @Get('preview')
  @RequirePermissions(P['exchange-rate.view'])
  preview(@CurrentUser() user: AuthenticatedUser, @Query() query: PreviewQueryDto) {
    return this.fx.preview(user.companyId!, query.asOfDate);
  }

  @Get(':id')
  @RequirePermissions(P['exchange-rate.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.fx.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['fx.revalue'])
  @ApiOperation({
    summary:
      'Revalue open foreign-currency receivables / payables at closing rates (auto-reversing)',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateRevaluationDto) {
    return this.fx.create(user.companyId!, user, body);
  }
}
