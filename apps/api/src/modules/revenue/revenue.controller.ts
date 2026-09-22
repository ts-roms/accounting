import {
  Body,
  Controller,
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
  completeMilestoneSchema,
  createRevenuePolicySchema,
  createRevenueRunSchema,
  isoDateSchema,
  listRevenueRunsQuerySchema,
  listRevenueSchedulesQuerySchema,
  revenueBacklogQuerySchema,
  revenueIntegrityQuerySchema,
  revenueRollforwardQuerySchema,
  revenueWaterfallQuerySchema,
  reverseRevenueRunSchema,
  updateRevenuePolicySchema,
  updateRevenueSettingsSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { businessToday } from '@/common/time/clock';
import { RevenueConfigService } from './revenue-config.service';
import { RevenueReportsService } from './revenue-reports.service';
import { RevenueRunsService } from './revenue-runs.service';
import { RevenueSchedulesService } from './revenue-schedules.service';
import { RevenueRecognitionJob } from './revenue.job';

class UpdateRevenueSettingsDto extends createZodDto(updateRevenueSettingsSchema) {}
class CreateRevenuePolicyDto extends createZodDto(createRevenuePolicySchema) {}
class UpdateRevenuePolicyDto extends createZodDto(updateRevenuePolicySchema) {}
class ListRevenueSchedulesQueryDto extends createZodDto(listRevenueSchedulesQuerySchema) {}
class CompleteMilestoneDto extends createZodDto(completeMilestoneSchema) {}
class ListRevenueRunsQueryDto extends createZodDto(listRevenueRunsQuerySchema) {}
class CreateRevenueRunDto extends createZodDto(createRevenueRunSchema) {}
class ReverseRevenueRunDto extends createZodDto(reverseRevenueRunSchema) {}
class PeriodEndQueryDto extends createZodDto(z.object({ periodEnd: isoDateSchema })) {}
class RollforwardQueryDto extends createZodDto(revenueRollforwardQuerySchema) {}
class WaterfallQueryDto extends createZodDto(revenueWaterfallQuerySchema) {}
class BacklogQueryDto extends createZodDto(revenueBacklogQuerySchema) {}
class IntegrityQueryDto extends createZodDto(revenueIntegrityQuerySchema) {}
class AsOfDto extends createZodDto(z.object({ asOf: isoDateSchema.optional() })) {}

/**
 * Revenue recognition & deferred revenue (Prompt #10). Policies and
 * settings are data; schedules are created by invoice posting; runs are
 * the only way deferred revenue reaches the income statement.
 */
@ApiTags('Revenue recognition')
@Controller('revenue')
@CompanyScoped()
export class RevenueController {
  constructor(
    private readonly config: RevenueConfigService,
    private readonly schedules: RevenueSchedulesService,
    private readonly runs: RevenueRunsService,
    private readonly reports: RevenueReportsService,
    private readonly job: RevenueRecognitionJob,
  ) {}

  // ----------------------------------------------------------------- settings

  @Get('settings')
  @RequirePermissions(P['revenue.view'])
  settings(@CurrentUser() user: AuthenticatedUser) {
    return this.config.settings(user.companyId!);
  }

  @Put('settings')
  @RequirePermissions(P['revenue.manage'])
  @ApiOperation({ summary: 'Automatic recognition, overdue grace period and the default policy' })
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateRevenueSettingsDto) {
    return this.config.updateSettings(user.companyId!, user, body);
  }

  // ----------------------------------------------------------------- policies

  @Get('policies')
  @RequirePermissions(P['revenue.view'])
  listPolicies(@CurrentUser() user: AuthenticatedUser) {
    return this.config.listPolicies(user.companyId!);
  }

  @Post('policies')
  @RequirePermissions(P['revenue.manage'])
  @ApiOperation({ summary: 'Create a recognition policy (point in time, ratable or milestone)' })
  createPolicy(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateRevenuePolicyDto) {
    return this.config.createPolicy(user.companyId!, user, body);
  }

  @Patch('policies/:id')
  @RequirePermissions(P['revenue.manage'])
  updatePolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRevenuePolicyDto,
  ) {
    return this.config.updatePolicy(user.companyId!, user, id, body);
  }

  // ---------------------------------------------------------------- schedules

  @Get('schedules')
  @RequirePermissions(P['revenue.view'])
  @ApiOperation({ summary: 'Deferred revenue schedules (one per deferred invoice line)' })
  listSchedules(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListRevenueSchedulesQueryDto,
  ) {
    return this.schedules.list(user.companyId!, query);
  }

  @Get('schedules/:id')
  @RequirePermissions(P['revenue.view'])
  getSchedule(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.get(user.companyId!, id);
  }

  @Post('schedules/:id/lines/:lineId/complete')
  @HttpCode(200)
  @RequirePermissions(P['revenue.manage'])
  @ApiOperation({ summary: 'Mark a milestone complete so the next run recognizes it' })
  completeMilestone(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: CompleteMilestoneDto,
  ) {
    return this.schedules.completeMilestone(user.companyId!, user, id, lineId, body);
  }

  // --------------------------------------------------------------------- runs

  @Get('runs')
  @RequirePermissions(P['revenue.view'])
  listRuns(@CurrentUser() user: AuthenticatedUser, @Query() query: ListRevenueRunsQueryDto) {
    return this.runs.list(user.companyId!, query);
  }

  @Get('runs/preview')
  @RequirePermissions(P['revenue.view'])
  @ApiOperation({ summary: 'What a run up to the given period end would recognize' })
  previewRun(@CurrentUser() user: AuthenticatedUser, @Query() query: PeriodEndQueryDto) {
    return this.runs.preview(user.companyId!, query.periodEnd);
  }

  @Get('runs/:id')
  @RequirePermissions(P['revenue.view'])
  getRun(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.get(user.companyId!, id);
  }

  @Post('runs')
  @RequirePermissions(P['revenue.recognize'])
  @ApiOperation({
    summary:
      'Recognize every due schedule line up to the period end in one journal (Dr deferred / Cr revenue)',
  })
  async createRun(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateRevenueRunDto) {
    const run = await this.runs.create(user.companyId!, user, body);
    return run ?? { run: null, message: 'Nothing is due for recognition.' };
  }

  @Post('runs/:id/reverse')
  @HttpCode(200)
  @RequirePermissions(P['revenue.recognize'])
  @ApiOperation({ summary: 'Reverse a run (latest first) and re-open its schedule lines' })
  reverseRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReverseRevenueRunDto,
  ) {
    return this.runs.reverse(user.companyId!, user, id, body);
  }

  @Post('recognize-now')
  @HttpCode(200)
  @RequirePermissions(P['revenue.recognize'])
  @ApiOperation({
    summary: 'Run the scheduled recognition job now (companies with automatic recognition)',
  })
  recognizeNow(@Query() query: AsOfDto) {
    return this.job.run(query.asOf);
  }

  // ------------------------------------------------------------------ reports

  @Get('reports/rollforward')
  @RequirePermissions(P['revenue.view'])
  @ApiOperation({ summary: 'Deferred revenue rollforward proven against the ledger balance' })
  rollforward(@CurrentUser() user: AuthenticatedUser, @Query() query: RollforwardQueryDto) {
    return this.reports.rollforward(user.companyId!, query);
  }

  @Get('reports/waterfall')
  @RequirePermissions(P['revenue.view'])
  @ApiOperation({ summary: 'Deferred revenue waterfall by month (and by customer)' })
  waterfall(@CurrentUser() user: AuthenticatedUser, @Query() query: WaterfallQueryDto) {
    return this.reports.waterfall(user.companyId!, query);
  }

  @Get('reports/backlog')
  @RequirePermissions(P['revenue.view'])
  @ApiOperation({ summary: 'Contracted-but-unearned revenue by customer' })
  backlog(@CurrentUser() user: AuthenticatedUser, @Query() query: BacklogQueryDto) {
    return this.reports.backlog(user.companyId!, query);
  }

  @Get('integrity')
  @RequirePermissions(P['revenue.view'])
  @ApiOperation({
    summary: 'Deferred revenue integrity checks (ledger vs schedules, totals, overdue lines)',
  })
  integrity(@CurrentUser() user: AuthenticatedUser, @Query() query: IntegrityQueryDto) {
    return this.reports.integrity(user.companyId!, query.asOf ?? businessToday());
  }
}
