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
  commenceLeaseSchema,
  createLeaseRunSchema,
  createLeaseSchema,
  isoDateSchema,
  leaseAsOfQuerySchema,
  leaseMaturityQuerySchema,
  listLeaseRunsQuerySchema,
  listLeasesQuerySchema,
  payLeaseLineSchema,
  previewLeaseScheduleSchema,
  remeasureLeaseSchema,
  reverseLeaseRunSchema,
  terminateLeaseSchema,
  updateLeaseSchema,
  updateLeaseSettingsSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { businessToday } from '@/common/time/clock';
import { LeaseReportsService } from './lease-reports.service';
import { LeaseRunsService } from './lease-runs.service';
import { LeasesConfigService } from './leases-config.service';
import { LeaseRunsJob } from './leases.job';
import { LeasesService } from './leases.service';

class UpdateLeaseSettingsDto extends createZodDto(updateLeaseSettingsSchema) {}
class CreateLeaseDto extends createZodDto(createLeaseSchema) {}
class UpdateLeaseDto extends createZodDto(updateLeaseSchema) {}
class ListLeasesQueryDto extends createZodDto(listLeasesQuerySchema) {}
class PreviewScheduleDto extends createZodDto(previewLeaseScheduleSchema) {}
class CommenceLeaseDto extends createZodDto(commenceLeaseSchema) {}
class PayLeaseLineDto extends createZodDto(payLeaseLineSchema) {}
class RemeasureLeaseDto extends createZodDto(remeasureLeaseSchema) {}
class TerminateLeaseDto extends createZodDto(terminateLeaseSchema) {}
class CreateLeaseRunDto extends createZodDto(createLeaseRunSchema) {}
class ReverseLeaseRunDto extends createZodDto(reverseLeaseRunSchema) {}
class ListLeaseRunsQueryDto extends createZodDto(listLeaseRunsQuerySchema) {}
class PeriodEndQueryDto extends createZodDto(z.object({ periodEnd: isoDateSchema })) {}
class AsOfDto extends createZodDto(leaseAsOfQuerySchema) {}
class MaturityQueryDto extends createZodDto(leaseMaturityQuerySchema) {}

const today = businessToday;

/**
 * Lease accounting (Prompt #13). Contracts and settings are data; every
 * ledger effect is an explicit posting action guarded by `lease.post`.
 */
@ApiTags('Leases')
@Controller('leases')
@CompanyScoped()
export class LeasesController {
  constructor(
    private readonly config: LeasesConfigService,
    private readonly leases: LeasesService,
    private readonly runs: LeaseRunsService,
    private readonly reports: LeaseReportsService,
    private readonly job: LeaseRunsJob,
  ) {}

  // ----------------------------------------------------------------- settings

  @Get('settings')
  @RequirePermissions(P['lease.view'])
  settings(@CurrentUser() user: AuthenticatedUser) {
    return this.config.settings(user.companyId!);
  }

  @Put('settings')
  @RequirePermissions(P['lease.manage'])
  @ApiOperation({ summary: 'Exemption thresholds, default discount rate, automatic runs' })
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateLeaseSettingsDto) {
    return this.config.updateSettings(user.companyId!, user, body);
  }

  // ------------------------------------------------------------------ reports

  @Get('reports/register')
  @RequirePermissions(P['lease.view'])
  @ApiOperation({
    summary: 'Lease register: liability and right-of-use carrying amounts per lease',
  })
  register(@CurrentUser() user: AuthenticatedUser, @Query() query: AsOfDto) {
    return this.reports.register(user.companyId!, query.asOf ?? today());
  }

  @Get('reports/maturity')
  @RequirePermissions(P['lease.view'])
  @ApiOperation({ summary: 'Undiscounted maturity analysis and current / non-current split' })
  maturity(@CurrentUser() user: AuthenticatedUser, @Query() query: MaturityQueryDto) {
    return this.reports.maturity(user.companyId!, query.asOf ?? today(), query.years);
  }

  @Get('dashboard')
  @RequirePermissions(P['lease.view'])
  dashboard(@CurrentUser() user: AuthenticatedUser, @Query() query: AsOfDto) {
    return this.reports.dashboard(user.companyId!, query.asOf ?? today());
  }

  @Get('integrity')
  @RequirePermissions(P['lease.view'])
  @ApiOperation({ summary: 'Register vs ledger, schedule totals, overdue runs and payments' })
  integrity(@CurrentUser() user: AuthenticatedUser, @Query() query: AsOfDto) {
    return this.reports.integrity(user.companyId!, query.asOf ?? today());
  }

  // --------------------------------------------------------------------- runs

  @Get('runs')
  @RequirePermissions(P['lease.view'])
  listRuns(@CurrentUser() user: AuthenticatedUser, @Query() query: ListLeaseRunsQueryDto) {
    return this.runs.list(user.companyId!, query);
  }

  @Get('runs/preview')
  @RequirePermissions(P['lease.view'])
  @ApiOperation({ summary: 'What a run up to the period end would post' })
  previewRun(@CurrentUser() user: AuthenticatedUser, @Query() query: PeriodEndQueryDto) {
    return this.runs.preview(user.companyId!, query.periodEnd);
  }

  @Get('runs/:id')
  @RequirePermissions(P['lease.view'])
  getRun(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.get(user.companyId!, id);
  }

  @Post('runs')
  @RequirePermissions(P['lease.post'])
  @ApiOperation({
    summary: 'Post interest accretion and right-of-use depreciation for every month due',
  })
  async createRun(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateLeaseRunDto) {
    const run = await this.runs.create(user.companyId!, user, body);
    return run ?? { run: null, message: 'Nothing due up to the period end.' };
  }

  @Post('runs/:id/reverse')
  @HttpCode(200)
  @RequirePermissions(P['lease.post'])
  reverseRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReverseLeaseRunDto,
  ) {
    return this.runs.reverse(user.companyId!, user, id, body);
  }

  @Post('runs/sweep')
  @HttpCode(200)
  @RequirePermissions(P['lease.post'])
  @ApiOperation({ summary: 'Run the scheduled lease job now (all companies)' })
  sweep(@Query() query: AsOfDto) {
    return this.job.run(query.asOf ?? today());
  }

  // ------------------------------------------------------------------- leases

  @Get()
  @RequirePermissions(P['lease.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListLeasesQueryDto) {
    return this.leases.list(user.companyId!, query);
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermissions(P['lease.view'])
  @ApiOperation({ summary: 'Schedule for terms that are not saved yet' })
  preview(@CurrentUser() user: AuthenticatedUser, @Body() body: PreviewScheduleDto) {
    return this.leases.preview(user.companyId!, body);
  }

  @Get(':id')
  @RequirePermissions(P['lease.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.leases.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['lease.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateLeaseDto) {
    return this.leases.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['lease.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLeaseDto,
  ) {
    return this.leases.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['lease.manage'])
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.leases.remove(user.companyId!, id);
  }

  @Post(':id/commence')
  @HttpCode(200)
  @RequirePermissions(P['lease.post'])
  @ApiOperation({
    summary:
      'Commence: Dr right-of-use asset / Cr lease liability at present value (exempt leases: schedule only)',
  })
  commence(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CommenceLeaseDto,
  ) {
    return this.leases.commence(user.companyId!, user, id, body);
  }

  @Post(':id/pay')
  @HttpCode(200)
  @RequirePermissions(P['lease.post'])
  @ApiOperation({ summary: 'Pay a scheduled instalment from a bank account' })
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PayLeaseLineDto,
  ) {
    return this.leases.pay(user.companyId!, user, id, body);
  }

  @Post(':id/remeasure')
  @HttpCode(200)
  @RequirePermissions(P['lease.post'])
  @ApiOperation({ summary: 'Modify term / payment / rate from an effective date' })
  remeasure(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RemeasureLeaseDto,
  ) {
    return this.leases.remeasure(user.companyId!, user, id, body);
  }

  @Post(':id/terminate')
  @HttpCode(200)
  @RequirePermissions(P['lease.post'])
  @ApiOperation({ summary: 'Derecognize the asset and liability; books the gain / loss' })
  terminate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TerminateLeaseDto,
  ) {
    return this.leases.terminate(user.companyId!, user, id, body);
  }
}
