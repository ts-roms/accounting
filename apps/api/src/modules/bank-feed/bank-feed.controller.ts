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
  applyBankSuggestionSchema,
  bankFeedDashboardQuerySchema,
  bankFeedQueueQuerySchema,
  createBankMatchingRuleSchema,
  explainBankLineSchema,
  isoDateSchema,
  suggestBankFeedSchema,
  testBankMatchingRuleSchema,
  updateBankFeedSettingsSchema,
  updateBankMatchingRuleSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { BankFeedIntegrityService } from './bank-feed-integrity.service';
import { BankFeedRulesService } from './bank-feed-rules.service';
import { BankFeedService } from './bank-feed.service';
import { BankFeedSweepJob } from './bank-feed.job';

class UpdateSettingsDto extends createZodDto(updateBankFeedSettingsSchema) {}
class CreateRuleDto extends createZodDto(createBankMatchingRuleSchema) {}
class UpdateRuleDto extends createZodDto(updateBankMatchingRuleSchema) {}
class TestRuleDto extends createZodDto(testBankMatchingRuleSchema) {}
class QueueQueryDto extends createZodDto(bankFeedQueueQuerySchema) {}
class SuggestDto extends createZodDto(suggestBankFeedSchema) {}
class ApplyDto extends createZodDto(applyBankSuggestionSchema) {}
class ExplainDto extends createZodDto(explainBankLineSchema) {}
class DashboardQueryDto extends createZodDto(bankFeedDashboardQuerySchema) {}
class AsOfDto extends createZodDto(z.object({ asOf: isoDateSchema.optional() })) {}

/**
 * Bank feed auto-reconciliation (Prompt #12): rules and settings are data;
 * the review queue explains statement lines through the owning document
 * services and never writes journals itself.
 */
@ApiTags('Bank feed')
@Controller('banking/feed')
@CompanyScoped()
export class BankFeedController {
  constructor(
    private readonly feed: BankFeedService,
    private readonly rules: BankFeedRulesService,
    private readonly integrity: BankFeedIntegrityService,
    private readonly sweep: BankFeedSweepJob,
  ) {}

  // ----------------------------------------------------------------- settings

  @Get('settings')
  @RequirePermissions(P['bank-account.view'])
  settings(@CurrentUser() user: AuthenticatedUser) {
    return this.rules.settings(user.companyId!);
  }

  @Put('settings')
  @RequirePermissions(P['bank-feed.manage'])
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateSettingsDto) {
    return this.rules.updateSettings(user.companyId!, user, body);
  }

  // -------------------------------------------------------------------- rules

  @Get('rules')
  @RequirePermissions(P['bank-account.view'])
  listRules(@CurrentUser() user: AuthenticatedUser) {
    return this.rules.list(user.companyId!);
  }

  @Post('rules')
  @RequirePermissions(P['bank-feed.manage'])
  @ApiOperation({
    summary: 'Create a matching rule (pattern / amount conditions -> what explains the line)',
  })
  createRule(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateRuleDto) {
    return this.rules.create(user.companyId!, user, body);
  }

  @Post('rules/test')
  @HttpCode(200)
  @RequirePermissions(P['bank-account.view'])
  @ApiOperation({ summary: 'Dry run: which unexplained lines a rule draft would match' })
  testRule(@CurrentUser() user: AuthenticatedUser, @Body() body: TestRuleDto) {
    return this.rules.test(user.companyId!, body);
  }

  @Patch('rules/:id')
  @RequirePermissions(P['bank-feed.manage'])
  updateRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRuleDto,
  ) {
    return this.rules.update(user.companyId!, user, id, body);
  }

  @Delete('rules/:id')
  @HttpCode(204)
  @RequirePermissions(P['bank-feed.manage'])
  async removeRule(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.rules.remove(user.companyId!, user, id);
  }

  // ------------------------------------------------------------------- queue

  @Get('queue')
  @RequirePermissions(P['bank-account.view'])
  @ApiOperation({
    summary: 'Unexplained statement lines of open statements with their pending suggestions',
  })
  queue(@CurrentUser() user: AuthenticatedUser, @Query() query: QueueQueryDto) {
    return this.feed.queue(user.companyId!, query);
  }

  @Post('suggest')
  @HttpCode(200)
  @RequirePermissions(P['bank-feed.manage'])
  @ApiOperation({
    summary:
      'Refresh suggestions (rules, open documents, history) and auto-apply what policy allows',
  })
  suggest(@CurrentUser() user: AuthenticatedUser, @Body() body: SuggestDto) {
    return this.feed.suggest(user.companyId!, user, body);
  }

  @Get('suggestions/:id')
  @RequirePermissions(P['bank-account.view'])
  getSuggestion(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.feed.getSuggestion(user.companyId!, id);
  }

  @Post('suggestions/:id/apply')
  @HttpCode(200)
  @RequirePermissions(P['bank-feed.manage'])
  @ApiOperation({ summary: 'Apply a suggestion: post the explaining document and match the line' })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApplyDto,
  ) {
    return this.feed.apply(user.companyId!, user, id, body);
  }

  @Post('suggestions/:id/dismiss')
  @HttpCode(200)
  @RequirePermissions(P['bank-feed.manage'])
  dismiss(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.feed.dismiss(user.companyId!, user, id);
  }

  @Post('lines/:lineId/explain')
  @HttpCode(200)
  @RequirePermissions(P['bank-feed.manage'])
  @ApiOperation({ summary: 'Explain a line by hand (transaction, receipt, payment or ignore)' })
  explain(
    @CurrentUser() user: AuthenticatedUser,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: ExplainDto,
  ) {
    return this.feed.explain(user.companyId!, user, lineId, body);
  }

  // --------------------------------------------------------------- reporting

  @Get('dashboard')
  @RequirePermissions(P['bank-account.view'])
  @ApiOperation({
    summary: 'Reconciliation KPIs: automation rate, pending lines, ageing, rule hits',
  })
  dashboard(@CurrentUser() user: AuthenticatedUser, @Query() query: DashboardQueryDto) {
    return this.feed.dashboard(
      user.companyId!,
      query.asOf ?? new Date().toISOString().slice(0, 10),
      query.days,
    );
  }

  @Get('integrity')
  @RequirePermissions(P['bank-account.view'])
  runIntegrity(@CurrentUser() user: AuthenticatedUser, @Query() query: AsOfDto) {
    return this.integrity.run(user.companyId!, query.asOf ?? new Date().toISOString().slice(0, 10));
  }

  @Post('sweep')
  @HttpCode(200)
  @RequirePermissions(P['bank-feed.manage'])
  @ApiOperation({ summary: 'Run the daily suggestion sweep now' })
  runSweep(@Query() query: AsOfDto) {
    return this.sweep.run(query.asOf);
  }
}
