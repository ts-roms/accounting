import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  consolidationMemberSchema,
  createConsolidationAdjustmentSchema,
  createConsolidationGroupSchema,
  createConsolidationRunSchema,
  createEliminationRuleSchema,
  finalizeConsolidationRunSchema,
  groupReadinessQuerySchema,
  intercompanyReconciliationQuerySchema,
  isoDateSchema,
  listConsolidationRunsQuerySchema,
  reopenConsolidationRunSchema,
  settleIntercompanySchema,
  updateConsolidationGroupSchema,
  updateConsolidationMemberSchema,
  updateEliminationRuleSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ConsolidationGroupsService } from './consolidation-groups.service';
import { ConsolidationIntegrityService } from './consolidation-integrity.service';
import { ConsolidationRunsService } from './consolidation-runs.service';
import { IntercompanyReconciliationService } from './intercompany-reconciliation.service';
import { IntercompanyService } from './intercompany.service';

class CreateGroupDto extends createZodDto(createConsolidationGroupSchema) {}
class UpdateGroupDto extends createZodDto(updateConsolidationGroupSchema) {}
class MemberDto extends createZodDto(consolidationMemberSchema) {}
class UpdateMemberDto extends createZodDto(updateConsolidationMemberSchema) {}
class CreateRuleDto extends createZodDto(createEliminationRuleSchema) {}
class UpdateRuleDto extends createZodDto(updateEliminationRuleSchema) {}
class CreateRunDto extends createZodDto(createConsolidationRunSchema) {}
class ListRunsQueryDto extends createZodDto(listConsolidationRunsQuerySchema) {}
class CreateAdjustmentDto extends createZodDto(createConsolidationAdjustmentSchema) {}
class FinalizeDto extends createZodDto(finalizeConsolidationRunSchema) {}
class ReopenDto extends createZodDto(reopenConsolidationRunSchema) {}
class ReasonDto extends createZodDto(z.object({ reason: z.string().trim().min(1).max(500) })) {}
class ReadinessQueryDto extends createZodDto(groupReadinessQuerySchema) {}
class ReconciliationQueryDto extends createZodDto(intercompanyReconciliationQuerySchema) {}
class AsOfQueryDto extends createZodDto(z.object({ asOf: isoDateSchema.optional() })) {}
class SettleDto extends createZodDto(settleIntercompanySchema) {}

/** Organization-level (a group spans companies): no X-Company-Id required. */
@ApiTags('Consolidation')
@Controller('consolidation/groups')
export class ConsolidationGroupsController {
  constructor(
    private readonly groups: ConsolidationGroupsService,
    private readonly runs: ConsolidationRunsService,
  ) {}

  @Get()
  @RequirePermissions(P['consolidation.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.groups.list(user.organizationId);
  }

  @Get(':id')
  @RequirePermissions(P['consolidation.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.groups.get(user.organizationId, id);
  }

  @Post()
  @RequirePermissions(P['consolidation.manage'])
  @ApiOperation({
    summary: 'Create a group around a parent entity (the parent joins as a 100% full member)',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateGroupDto) {
    return this.groups.create(user.organizationId, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['consolidation.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateGroupDto,
  ) {
    return this.groups.update(user.organizationId, user, id, body);
  }

  @Post(':id/members')
  @RequirePermissions(P['consolidation.manage'])
  @ApiOperation({
    summary:
      'Add a subsidiary / joint venture / associate with its method, ownership and acquisition data',
  })
  addMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MemberDto,
  ) {
    return this.groups.addMember(user.organizationId, user, id, body);
  }

  @Patch(':id/members/:memberId')
  @RequirePermissions(P['consolidation.manage'])
  updateMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() body: UpdateMemberDto,
  ) {
    return this.groups.updateMember(user.organizationId, user, id, memberId, body);
  }

  @Delete(':id/members/:memberId')
  @RequirePermissions(P['consolidation.manage'])
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return this.groups.removeMember(user.organizationId, user, id, memberId);
  }

  @Post(':id/rules')
  @RequirePermissions(P['consolidation.manage'])
  createRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateRuleDto,
  ) {
    return this.groups.createRule(user.organizationId, user, id, body);
  }

  @Post(':id/rules/defaults')
  @RequirePermissions(P['consolidation.manage'])
  @ApiOperation({
    summary: 'Add the default intercompany-balances and investment rules when the group has none',
  })
  seedRules(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.groups.seedDefaultRules(user.organizationId, user, id);
  }

  @Patch(':id/rules/:ruleId')
  @RequirePermissions(P['consolidation.manage'])
  updateRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() body: UpdateRuleDto,
  ) {
    return this.groups.updateRule(user.organizationId, user, id, ruleId, body);
  }

  @Get(':id/readiness')
  @RequirePermissions(P['consolidation.view'])
  @ApiOperation({
    summary: 'Group close readiness: member periods closed, rates loaded, intercompany matched',
  })
  readiness(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ReadinessQueryDto,
  ) {
    return this.runs.readiness(user.organizationId, id, query.periodStart, query.periodEnd);
  }

  @Post(':id/runs')
  @RequirePermissions(P['consolidation.run'])
  @ApiOperation({
    summary: 'Open a fiscal-year-to-date consolidation run and prepare it from the member ledgers',
  })
  createRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateRunDto,
  ) {
    return this.runs.create(user.organizationId, user, id, body);
  }
}

@ApiTags('Consolidation')
@Controller('consolidation/runs')
export class ConsolidationRunsController {
  constructor(private readonly runs: ConsolidationRunsService) {}

  @Get()
  @RequirePermissions(P['consolidation.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListRunsQueryDto) {
    return this.runs.list(user.organizationId, query);
  }

  @Get(':id')
  @RequirePermissions(P['consolidation.view'])
  @ApiOperation({
    summary: 'Run with member columns, adjustments, the consolidated trial balance and readiness',
  })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.get(user.organizationId, id);
  }

  @Get(':id/statements')
  @RequirePermissions(P['consolidation.view'])
  @ApiOperation({ summary: 'Consolidated balance sheet and income statement with NCI attribution' })
  statements(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.statements(user.organizationId, id);
  }

  @Post(':id/prepare')
  @RequirePermissions(P['consolidation.run'])
  @ApiOperation({
    summary:
      'Re-read the member ledgers and regenerate the rule-driven adjustments (manual ones are kept)',
  })
  prepare(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.prepare(user.organizationId, user, id);
  }

  @Post(':id/adjustments')
  @RequirePermissions(P['consolidation.run'])
  addAdjustment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateAdjustmentDto,
  ) {
    return this.runs.addAdjustment(user.organizationId, user, id, body);
  }

  @Post(':id/adjustments/:adjustmentId/void')
  @RequirePermissions(P['consolidation.run'])
  voidAdjustment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('adjustmentId', ParseUUIDPipe) adjustmentId: string,
    @Body() body: ReasonDto,
  ) {
    return this.runs.voidAdjustment(user.organizationId, user, id, adjustmentId, body.reason);
  }

  @Post(':id/finalize')
  @RequirePermissions(P['consolidation.approve'])
  @ApiOperation({
    summary:
      'Finalize the group close (delegable; segregated from the preparer; freezes member figures)',
  })
  finalize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FinalizeDto,
  ) {
    return this.runs.finalize(user.organizationId, user, id, body.note);
  }

  @Post(':id/reopen')
  @RequirePermissions(P['consolidation.approve'])
  reopen(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReopenDto,
  ) {
    return this.runs.reopen(user.organizationId, user, id, body.reason);
  }
}

@ApiTags('Consolidation')
@Controller('consolidation')
export class ConsolidationPlatformController {
  constructor(
    private readonly reconciliation: IntercompanyReconciliationService,
    private readonly integrity: ConsolidationIntegrityService,
  ) {}

  @Get('intercompany-reconciliation')
  @RequirePermissions(P['consolidation.view'])
  @ApiOperation({
    summary: 'Intercompany balances by company pair and per entity against the ledger',
  })
  reconcile(@CurrentUser() user: AuthenticatedUser, @Query() query: ReconciliationQueryDto) {
    return this.reconciliation.reconcile(user.organizationId, query);
  }

  @Get('integrity')
  @RequirePermissions(P['consolidation.view'])
  runIntegrity(@CurrentUser() user: AuthenticatedUser, @Query() query: AsOfQueryDto) {
    return this.integrity.run(
      user.organizationId,
      query.asOf ?? new Date().toISOString().slice(0, 10),
    );
  }
}

@ApiTags('Intercompany')
@Controller('intercompany')
export class IntercompanySettlementController {
  constructor(private readonly intercompany: IntercompanyService) {}

  @Post(':id/settle')
  @RequirePermissions(P['intercompany.post'])
  @ApiOperation({ summary: 'Settle a posted charge in cash: both bank legs post atomically' })
  settle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SettleDto,
  ) {
    return this.intercompany.settle(user.organizationId, user, id, body);
  }
}
