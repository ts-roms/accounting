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
  capitalizeAssetSchema,
  createAssetCategorySchema,
  createAssetSchema,
  createDepreciationRunSchema,
  disposeAssetSchema,
  fixedAssetSettingsSchema,
  impairAssetSchema,
  isoDateSchema,
  assetRollforwardQuerySchema,
  listAssetsQuerySchema,
  listDepreciationRunsQuerySchema,
  revalueAssetSchema,
  splitAssetSchema,
  transferAssetSchema,
  updateAssetCategorySchema,
  updateAssetSchema,
  uuidSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { AssetReportsService } from './asset-reports.service';
import { DepreciationRunsService } from './depreciation-runs.service';
import { FixedAssetsService } from './fixed-assets.service';

class ListAssetsQueryDto extends createZodDto(listAssetsQuerySchema) {}
class CreateAssetDto extends createZodDto(createAssetSchema) {}
class UpdateAssetDto extends createZodDto(updateAssetSchema) {}
class CreateCategoryDto extends createZodDto(createAssetCategorySchema) {}
class UpdateCategoryDto extends createZodDto(updateAssetCategorySchema) {}
class CapitalizeDto extends createZodDto(capitalizeAssetSchema) {}
class TransferDto extends createZodDto(transferAssetSchema) {}
class ImpairDto extends createZodDto(impairAssetSchema) {}
class RevalueDto extends createZodDto(revalueAssetSchema) {}
class DisposeDto extends createZodDto(disposeAssetSchema) {}
class SplitDto extends createZodDto(splitAssetSchema) {}
class RollforwardQueryDto extends createZodDto(assetRollforwardQuerySchema) {}
class SettingsDto extends createZodDto(fixedAssetSettingsSchema) {}
class ListRunsQueryDto extends createZodDto(listDepreciationRunsQuerySchema) {}
class CreateRunDto extends createZodDto(createDepreciationRunSchema) {}
class ReverseRunDto extends createZodDto(z.object({ reason: z.string().trim().min(1).max(500) })) {}
class PreviewQueryDto extends createZodDto(z.object({ fiscalPeriodId: uuidSchema })) {}
class ScheduledDto extends createZodDto(z.object({ asOf: isoDateSchema.optional() })) {}

@ApiTags('Fixed Assets')
@Controller('fixed-assets')
@CompanyScoped()
export class FixedAssetsController {
  constructor(
    private readonly assets: FixedAssetsService,
    private readonly reports: AssetReportsService,
  ) {}

  @Get('reports/rollforward')
  @RequirePermissions(P['fixed-asset.view'])
  @ApiOperation({
    summary:
      'Register rollforward per category (and right-of-use assets): opening, additions, depreciation, impairment, revaluation, disposals, closing',
  })
  rollforward(@CurrentUser() user: AuthenticatedUser, @Query() query: RollforwardQueryDto) {
    return this.reports.rollforward(user.companyId!, query);
  }

  @Get()
  @RequirePermissions(P['fixed-asset.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListAssetsQueryDto) {
    return this.assets.list(user.companyId!, query);
  }

  @Get('settings')
  @RequirePermissions(P['fixed-asset.view'])
  settings(@CurrentUser() user: AuthenticatedUser) {
    return this.assets.settings(user.companyId!);
  }

  @Put('settings')
  @RequirePermissions(P['depreciation.run'])
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: SettingsDto) {
    return this.assets.updateSettings(user.companyId!, user, body);
  }

  @Get(':id')
  @RequirePermissions(P['fixed-asset.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['fixed-asset.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateAssetDto) {
    return this.assets.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['fixed-asset.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAssetDto,
  ) {
    return this.assets.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['fixed-asset.manage'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.assets.remove(user.companyId!, id);
  }

  @Post(':id/capitalize')
  @RequirePermissions(P['fixed-asset.post'])
  @ApiOperation({
    summary: 'Dr asset cost / Cr clearing (or given account); asset starts depreciating',
  })
  capitalize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CapitalizeDto,
  ) {
    return this.assets.capitalize(user.companyId!, user, id, body);
  }

  @Post(':id/transfer')
  @RequirePermissions(P['fixed-asset.manage'])
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TransferDto,
  ) {
    return this.assets.transfer(user.companyId!, user, id, body);
  }

  @Post(':id/impair')
  @RequirePermissions(P['fixed-asset.post'])
  impair(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ImpairDto,
  ) {
    return this.assets.impair(user.companyId!, user, id, body);
  }

  @Post(':id/revalue')
  @RequirePermissions(P['fixed-asset.post'])
  revalue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevalueDto,
  ) {
    return this.assets.revalue(user.companyId!, user, id, body);
  }

  @Post(':id/split')
  @HttpCode(200)
  @RequirePermissions(P['fixed-asset.manage'])
  @ApiOperation({ summary: 'Carve child assets out of this one (register only, no posting)' })
  split(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SplitDto,
  ) {
    return this.assets.split(user.companyId!, user, id, body);
  }

  @Post(':id/dispose')
  @RequirePermissions(P['fixed-asset.post'])
  @ApiOperation({ summary: 'Dispose (proceeds > 0) or write off; books gain / loss on disposal' })
  dispose(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DisposeDto,
  ) {
    return this.assets.dispose(user.companyId!, user, id, body);
  }
}

@ApiTags('Asset Categories')
@Controller('asset-categories')
@CompanyScoped()
export class AssetCategoriesController {
  constructor(private readonly assets: FixedAssetsService) {}

  @Get()
  @RequirePermissions(P['fixed-asset.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.assets.listCategories(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['fixed-asset.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCategoryDto) {
    return this.assets.createCategory(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['fixed-asset.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCategoryDto,
  ) {
    return this.assets.updateCategory(user.companyId!, user, id, body);
  }
}

@ApiTags('Depreciation')
@Controller('depreciation-runs')
@CompanyScoped()
export class DepreciationRunsController {
  constructor(private readonly runs: DepreciationRunsService) {}

  @Get()
  @RequirePermissions(P['fixed-asset.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListRunsQueryDto) {
    return this.runs.list(user.companyId!, query);
  }

  @Get('preview')
  @RequirePermissions(P['fixed-asset.view'])
  @ApiOperation({ summary: 'What a run for the period would post' })
  preview(@CurrentUser() user: AuthenticatedUser, @Query() query: PreviewQueryDto) {
    return this.runs.previewForCompany(user.companyId!, query.fiscalPeriodId);
  }

  @Get(':id')
  @RequirePermissions(P['fixed-asset.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['depreciation.run'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateRunDto) {
    return this.runs.create(user.companyId!, user, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['depreciation.run'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.runs.remove(user.companyId!, id);
  }

  @Post(':id/post')
  @RequirePermissions(P['depreciation.run'])
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.post(user.companyId!, user, id);
  }

  @Post(':id/reverse')
  @RequirePermissions(P['depreciation.run'])
  reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReverseRunDto,
  ) {
    return this.runs.reverse(user.companyId!, user, id, body.reason);
  }

  @Post('scheduled')
  @RequirePermissions(P['depreciation.run'])
  @ApiOperation({ summary: 'Run the monthly depreciation job now (what the scheduler does)' })
  scheduled(@CurrentUser() user: AuthenticatedUser, @Body() body: ScheduledDto) {
    return this.runs.runScheduled(body.asOf ?? new Date().toISOString().slice(0, 10), user);
  }
}
