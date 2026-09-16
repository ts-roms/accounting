import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  dimensionRuleSchema,
  listPrepaymentsQuerySchema,
  listRecurringJournalsQuerySchema,
  postingRuleSchema,
  prepaymentSchema,
  recognizePrepaymentsSchema,
  recurringJournalSchema,
  runRecurringJournalsSchema,
  simulatePostingRuleSchema,
  suspenseQuerySchema,
  updateDimensionRuleSchema,
  updatePostingRuleSchema,
  updateRecurringJournalSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { DimensionRulesService } from './dimensions/dimension-rules.service';
import { PostingRulesService } from './posting-rules/posting-rules.service';
import { PrepaymentsService } from './prepayments/prepayments.service';
import { RecurringJournalsService } from './recurring/recurring-journals.service';
import { SuspenseService } from './suspense/suspense.service';

class RecurringJournalDto extends createZodDto(recurringJournalSchema) {}
class UpdateRecurringJournalDto extends createZodDto(updateRecurringJournalSchema) {}
class ListRecurringJournalsQueryDto extends createZodDto(listRecurringJournalsQuerySchema) {}
class RunRecurringJournalsDto extends createZodDto(runRecurringJournalsSchema) {}

/** Recurring journal templates and their runs. */
@ApiTags('Recurring Journals')
@Controller('accounting/recurring-journals')
@CompanyScoped()
export class RecurringJournalsController {
  constructor(private readonly service: RecurringJournalsService) {}

  @Get()
  @RequirePermissions(P['recurring-journal.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListRecurringJournalsQueryDto) {
    return this.service.list(user.companyId!, query);
  }

  @Post('run')
  @RequirePermissions(P['recurring-journal.manage'])
  @ApiOperation({
    summary: 'Generate every occurrence due on or before asOf (idempotent per occurrence)',
  })
  run(@CurrentUser() user: AuthenticatedUser, @Body() body: RunRecurringJournalsDto) {
    return this.service.run(user.companyId!, user, body);
  }

  @Get(':id')
  @RequirePermissions(P['recurring-journal.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['recurring-journal.manage'])
  @ApiOperation({
    summary: 'Create a template (AUTO_POST mode additionally requires journal.post)',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: RecurringJournalDto) {
    return this.service.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['recurring-journal.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRecurringJournalDto,
  ) {
    return this.service.update(user.companyId!, user, id, body);
  }
}

class PrepaymentDto extends createZodDto(prepaymentSchema) {}
class ListPrepaymentsQueryDto extends createZodDto(listPrepaymentsQuerySchema) {}
class RecognizePrepaymentsDto extends createZodDto(recognizePrepaymentsSchema) {}
class CancelPrepaymentDto extends createZodDto(
  z.object({ reason: z.string().trim().min(5).max(500) }),
) {}

/** Prepaid expenses and their recognition schedules. */
@ApiTags('Prepayments')
@Controller('accounting/prepayments')
@CompanyScoped()
export class PrepaymentsController {
  constructor(private readonly service: PrepaymentsService) {}

  @Get()
  @RequirePermissions(P['prepayment.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPrepaymentsQueryDto) {
    return this.service.list(user.companyId!, query);
  }

  @Post('recognize')
  @RequirePermissions(P['prepayment.post'])
  @ApiOperation({ summary: 'Post every pending recognition dated on or before asOf' })
  recognize(@CurrentUser() user: AuthenticatedUser, @Body() body: RecognizePrepaymentsDto) {
    return this.service.recognize(user.companyId!, user, body);
  }

  @Get(':id')
  @RequirePermissions(P['prepayment.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['prepayment.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: PrepaymentDto) {
    return this.service.create(user.companyId!, user, body);
  }

  @Post(':id/activate')
  @RequirePermissions(P['prepayment.post'])
  @ApiOperation({
    summary: 'Activate: posts Dr prepaid / Cr credit account and starts the schedule',
  })
  activate(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.activate(user.companyId!, user, id);
  }

  @Post(':id/cancel')
  @RequirePermissions(P['prepayment.manage'])
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelPrepaymentDto,
  ) {
    return this.service.cancel(user.companyId!, user, id, body.reason);
  }
}

class PostingRuleDto extends createZodDto(postingRuleSchema) {}
class UpdatePostingRuleDto extends createZodDto(updatePostingRuleSchema) {}
class SimulatePostingRuleDto extends createZodDto(simulatePostingRuleSchema) {}

/** Declarative Dr / Cr templates per transaction type. */
@ApiTags('Posting Rules')
@Controller('accounting/posting-rules')
@CompanyScoped()
export class PostingRulesController {
  constructor(private readonly service: PostingRulesService) {}

  @Get()
  @RequirePermissions(P['posting-rule.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.list(user.companyId!);
  }

  @Get(':id')
  @RequirePermissions(P['posting-rule.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['posting-rule.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: PostingRuleDto) {
    return this.service.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['posting-rule.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePostingRuleDto,
  ) {
    return this.service.update(user.companyId!, user, id, body);
  }

  @Post(':id/simulate')
  @RequirePermissions(P['posting-rule.view'])
  @ApiOperation({ summary: 'Resolve the rule against sample amounts without posting' })
  simulate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SimulatePostingRuleDto,
  ) {
    return this.service.simulate(user.companyId!, id, body);
  }
}

class DimensionRuleDto extends createZodDto(dimensionRuleSchema) {}
class UpdateDimensionRuleDto extends createZodDto(updateDimensionRuleSchema) {}

/** "Account X requires dimension Y" rules enforced by the posting engine. */
@ApiTags('Dimensions')
@Controller('accounting/dimension-rules')
@CompanyScoped()
export class DimensionRulesController {
  constructor(private readonly service: DimensionRulesService) {}

  @Get()
  @RequirePermissions(P['dimension.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.list(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['posting-rule.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: DimensionRuleDto) {
    return this.service.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['posting-rule.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDimensionRuleDto,
  ) {
    return this.service.update(user.companyId!, user, id, body);
  }
}

class SuspenseQueryDto extends createZodDto(suspenseQuerySchema) {}

/** Suspense account monitor. */
@ApiTags('Integrity')
@Controller('accounting/suspense')
@CompanyScoped()
export class SuspenseController {
  constructor(private readonly service: SuspenseService) {}

  @Get()
  @RequirePermissions(P['journal.view'])
  @ApiOperation({ summary: 'Suspense balances, unresolved postings, age and owner' })
  report(@CurrentUser() user: AuthenticatedUser, @Query() query: SuspenseQueryDto) {
    return this.service.monitor(
      user.companyId!,
      query.asOf ?? new Date().toISOString().slice(0, 10),
    );
  }
}
