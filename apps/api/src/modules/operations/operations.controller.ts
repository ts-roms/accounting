import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  failedJobsQuerySchema,
  jobNameSchema,
  listIntegrityRunsQuerySchema,
  listJobRunsQuerySchema,
  queueNameSchema,
  runIntegrityCheckSchema,
  statementsQuerySchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { AppError, ForbiddenError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { AppConfigService } from '@/config/app-config.service';
import { IntegrityService } from '@/modules/accounting/integrity/integrity.service';
import { AuditService } from '@/modules/audit/audit.service';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { QueueService, type QueueName } from '@/modules/jobs/queue.service';
import { IntegrityScheduleService } from './integrity-schedule.service';
import { MetricsService } from './metrics.service';
import { RuntimeStatusService } from './runtime-status.service';
import { StatementsService } from './statements.service';

class ListJobRunsQueryDto extends createZodDto(listJobRunsQuerySchema) {}
class ListIntegrityRunsQueryDto extends createZodDto(listIntegrityRunsQuerySchema) {}
class RunIntegrityCheckDto extends createZodDto(runIntegrityCheckSchema) {}
class FailedJobsQueryDto extends createZodDto(failedJobsQuerySchema) {}
class StatementsQueryDto extends createZodDto(statementsQuerySchema) {}

const parseJob = (name: string): string => {
  const parsed = jobNameSchema.safeParse(name);
  if (!parsed.success) throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Invalid job name');
  return parsed.data;
};
const parseQueue = (name: string): QueueName => {
  const parsed = queueNameSchema.safeParse(name);
  if (!parsed.success) throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Unknown queue');
  return parsed.data;
};

/**
 * Operations console API (hardening H8). Organization-level: not company
 * scoped, because jobs, queues and runtime status span every company.
 * Reading needs `operations.view`; anything that runs or changes work needs
 * `operations.manage` and is audited.
 */
@ApiTags('Operations')
@Controller('operations')
export class OperationsController {
  constructor(
    private readonly runtime: RuntimeStatusService,
    private readonly registry: JobRegistryService,
    private readonly queues: QueueService,
    private readonly integrity: IntegrityScheduleService,
    private readonly checks: IntegrityService,
    private readonly statements: StatementsService,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  @RequirePermissions(P['operations.view'])
  @ApiOperation({
    summary: 'Runtime status: version, dependencies, pending migrations, storage, queues',
  })
  status() {
    return this.runtime.status();
  }

  @Get('jobs')
  @RequirePermissions(P['operations.view'])
  @ApiOperation({
    summary: 'Registered background jobs with schedule, last run and failing streak',
  })
  jobs() {
    return this.registry.list();
  }

  @Post('jobs/:name/run')
  @RequirePermissions(P['operations.manage'])
  @ApiOperation({
    summary: 'Run a job now (advisory-locked; refused while another instance runs it)',
  })
  async runJob(@CurrentUser() user: AuthenticatedUser, @Param('name') name: string) {
    const run = await this.registry.trigger(parseJob(name), user);
    await this.audit.record({
      action: 'JOB_RUN',
      module: 'operations',
      entityType: 'JobRun',
      entityId: run.id,
      newValue: { jobName: run.jobName, status: run.status, durationMs: run.durationMs },
    });
    return run;
  }

  @Get('job-runs')
  @RequirePermissions(P['operations.view'])
  jobRuns(@Query() query: ListJobRunsQueryDto) {
    return this.registry.runs(query);
  }

  @Get('queues')
  @RequirePermissions(P['operations.view'])
  @ApiOperation({
    summary: 'Queue depths, failed counts and schedulers (null when Redis is unreachable)',
  })
  async queueStats() {
    return { keyPrefix: this.queues.keyPrefix, queues: await this.queues.stats() };
  }

  @Get('queues/:queue/failed')
  @RequirePermissions(P['operations.view'])
  @ApiOperation({ summary: 'Dead letter: failed jobs of one queue' })
  failed(@Param('queue') queue: string, @Query() query: FailedJobsQueryDto) {
    return this.queues.failed(parseQueue(queue), query.limit);
  }

  @Post('queues/:queue/failed/retry')
  @RequirePermissions(P['operations.manage'])
  @ApiOperation({ summary: 'Re-queue every failed job of a queue' })
  async retryAll(@CurrentUser() user: AuthenticatedUser, @Param('queue') queue: string) {
    const name = parseQueue(queue);
    const retried = await this.queues.retryFailed(name);
    await this.audit.record({
      action: 'QUEUE_RETRY',
      module: 'operations',
      entityType: 'Queue',
      entityId: name,
      newValue: { retried, by: user.email },
    });
    return { retried };
  }

  @Post('queues/:queue/failed/:id/retry')
  @RequirePermissions(P['operations.manage'])
  async retryOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('queue') queue: string,
    @Param('id') id: string,
  ) {
    const name = parseQueue(queue);
    const retried = await this.queues.retryFailed(name, id);
    await this.audit.record({
      action: 'QUEUE_RETRY',
      module: 'operations',
      entityType: 'Queue',
      entityId: name,
      newValue: { jobId: id, retried, by: user.email },
    });
    return { retried };
  }

  @Delete('queues/:queue/failed/:id')
  @RequirePermissions(P['operations.manage'])
  @HttpCode(204)
  @ApiOperation({ summary: 'Discard one failed job for good' })
  async discard(
    @CurrentUser() user: AuthenticatedUser,
    @Param('queue') queue: string,
    @Param('id') id: string,
  ) {
    const name = parseQueue(queue);
    const removed = await this.queues.discardFailed(name, id);
    await this.audit.record({
      action: 'QUEUE_DISCARD',
      module: 'operations',
      entityType: 'Queue',
      entityId: name,
      newValue: { jobId: id, removed, by: user.email },
    });
  }

  @Get('statements')
  @RequirePermissions(P['operations.view'])
  @ApiOperation({
    summary: 'Top database statements (pg_stat_statements) by total time, mean time, calls or rows',
  })
  statementStats(@Query() query: StatementsQueryDto) {
    return this.statements.top(query);
  }

  @Post('statements/reset')
  @RequirePermissions(P['operations.manage'])
  @HttpCode(204)
  @ApiOperation({ summary: 'Reset the pg_stat_statements counters (audited)' })
  async resetStatements(@CurrentUser() user: AuthenticatedUser) {
    await this.statements.reset();
    await this.audit.record({
      action: 'DELETE',
      module: 'operations',
      entityType: 'StatementStats',
      entityId: 'pg_stat_statements',
      newValue: { reset: true, by: user.email },
    });
  }

  @Get('integrity-runs')
  @RequirePermissions(P['operations.view'])
  integrityRuns(@Query() query: ListIntegrityRunsQueryDto) {
    return this.integrity.list(query);
  }

  @Post('integrity-runs')
  @RequirePermissions(P['operations.manage'])
  @ApiOperation({ summary: 'Run the integrity check for one company now and store the outcome' })
  runIntegrity(@CurrentUser() user: AuthenticatedUser, @Body() body: RunIntegrityCheckDto) {
    return this.integrity.runCompany(body.companyId, user);
  }

  @Post('period-balances/rebuild')
  @RequirePermissions(P['operations.manage'])
  @ApiOperation({
    summary: 'Recompute the account period-balance read model of one company from its ledger lines',
  })
  async rebuildPeriodBalances(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RunIntegrityCheckDto,
  ) {
    const result = await this.checks.rebuildPeriodBalances(body.companyId);
    await this.audit.record({
      action: 'REBUILD',
      module: 'operations',
      entityType: 'AccountPeriodBalances',
      entityId: body.companyId,
      newValue: { rows: result.rows, by: user.email },
    });
    return result;
  }
}

/**
 * Company-level view of the stored integrity runs for holders of `integrity.check`:
 * the dashboard reads the latest outcome instead of re-running every check on
 * each visit (`GET /integrity` stays the live, on-demand audit).
 */
@ApiTags('Integrity')
@Controller('integrity/runs')
@CompanyScoped()
export class IntegrityRunsController {
  constructor(private readonly integrity: IntegrityScheduleService) {}

  @Get('latest')
  @RequirePermissions(P['integrity.check'])
  @ApiOperation({ summary: 'Latest stored integrity run of the active company (null when none)' })
  latest(@CurrentUser() user: AuthenticatedUser) {
    return this.integrity.latest(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['integrity.check'])
  @ApiOperation({
    summary: 'Run the integrity checks for the active company now and store the outcome',
  })
  run(@CurrentUser() user: AuthenticatedUser) {
    return this.integrity.runCompany(user.companyId!, user);
  }
}

/** Readiness probe next to the existing /health (liveness + dependency) endpoints. */
@ApiTags('Health')
@Controller('health')
export class ReadinessController {
  constructor(private readonly runtime: RuntimeStatusService) {}

  @Public()
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness: 200 when the schema is current and the instance is not draining, else 503',
  })
  async ready(@Res() res: Response) {
    const result = await this.runtime.ready();
    res
      .status(result.ready ? 200 : 503)
      .json({ status: result.ready ? 'ready' : 'not_ready', ...result });
  }
}

/** Prometheus scrape endpoint; optionally protected by METRICS_TOKEN. */
@ApiTags('Health')
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({ summary: 'Prometheus metrics (bearer METRICS_TOKEN when configured)' })
  scrape(@Headers('authorization') authorization?: string) {
    const token = this.config.env.METRICS_TOKEN;
    if (token && authorization !== `Bearer ${token}`)
      throw new ForbiddenError('A valid metrics token is required.', ErrorCodes.PERMISSION_DENIED);
    return this.metrics.render();
  }
}
