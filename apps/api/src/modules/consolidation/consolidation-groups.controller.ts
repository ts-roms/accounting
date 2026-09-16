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
import { P } from '@accounting/types';
import {
  autoMapSchema,
  consolidationWindowSchema,
  createConsolidationAdjustmentSchema,
  createConsolidationGroupSchema,
  groupAccountSchema,
  groupMappingsSchema,
  listConsolidationRunsQuerySchema,
  updateConsolidationGroupSchema,
  updateGroupAccountSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ConsolidationGroupsService } from './consolidation-groups.service';
import { GroupConsolidationService } from './group-consolidation.service';

class CreateGroupDto extends createZodDto(createConsolidationGroupSchema) {}
class UpdateGroupDto extends createZodDto(updateConsolidationGroupSchema) {}
class GroupAccountDto extends createZodDto(groupAccountSchema) {}
class UpdateGroupAccountDto extends createZodDto(updateGroupAccountSchema) {}
class GroupMappingsDto extends createZodDto(groupMappingsSchema) {}
class AutoMapDto extends createZodDto(autoMapSchema) {}
class CreateAdjustmentDto extends createZodDto(createConsolidationAdjustmentSchema) {}
class WindowDto extends createZodDto(consolidationWindowSchema) {}
class ListRunsQueryDto extends createZodDto(listConsolidationRunsQuerySchema) {}

/**
 * Consolidation groups (hardening H9). Organization-level like the group
 * trial balance: reading needs `consolidation.view`, maintaining groups,
 * mappings, adjustments and finalising runs needs `consolidation.manage`.
 */
@ApiTags('Consolidation')
@Controller('consolidation/groups')
export class ConsolidationGroupsController {
  constructor(
    private readonly groups: ConsolidationGroupsService,
    private readonly engine: GroupConsolidationService,
  ) {}

  @Get()
  @RequirePermissions(P['consolidation.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.groups.list(user.organizationId);
  }

  @Post()
  @RequirePermissions(P['consolidation.manage'])
  @ApiOperation({
    summary: 'Create a group: parent, presentation currency, members with ownership and method',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateGroupDto) {
    return this.groups.create(user.organizationId, user, body);
  }

  @Get(':id')
  @RequirePermissions(P['consolidation.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.groups.get(user.organizationId, id);
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

  // ------------------------------------------------------- group chart & mappings

  @Get(':id/accounts')
  @RequirePermissions(P['consolidation.view'])
  groupAccounts(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.groups.groupAccounts(user.organizationId, id);
  }

  @Post(':id/accounts')
  @RequirePermissions(P['consolidation.manage'])
  createGroupAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: GroupAccountDto,
  ) {
    return this.groups.createGroupAccount(user.organizationId, user, id, body);
  }

  @Patch(':id/accounts/:accountId')
  @RequirePermissions(P['consolidation.manage'])
  updateGroupAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() body: UpdateGroupAccountDto,
  ) {
    return this.groups.updateGroupAccount(user.organizationId, user, id, accountId, body);
  }

  @Get(':id/mappings/:companyId')
  @RequirePermissions(P['consolidation.view'])
  @ApiOperation({ summary: "One member's chart with its current group-account mapping" })
  mappings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.groups.mappings(user.organizationId, id, companyId);
  }

  @Put(':id/mappings')
  @RequirePermissions(P['consolidation.manage'])
  saveMappings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: GroupMappingsDto,
  ) {
    return this.groups.saveMappings(user.organizationId, user, id, body);
  }

  @Post(':id/mappings/auto')
  @RequirePermissions(P['consolidation.manage'])
  @ApiOperation({
    summary: 'Map member accounts to group accounts by code (optionally creating the group chart)',
  })
  autoMap(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AutoMapDto,
  ) {
    return this.groups.autoMap(user.organizationId, user, id, body);
  }

  // ------------------------------------------------------------- adjustments

  @Get(':id/adjustments')
  @RequirePermissions(P['consolidation.view'])
  adjustments(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.groups.adjustments(user.organizationId, id);
  }

  @Post(':id/adjustments')
  @RequirePermissions(P['consolidation.manage'])
  @ApiOperation({
    summary:
      'Book a balanced group-level adjustment (investment elimination, unrealised profit...)',
  })
  createAdjustment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateAdjustmentDto,
  ) {
    return this.groups.createAdjustment(user.organizationId, user, id, body);
  }

  @Delete(':id/adjustments/:adjustmentId')
  @RequirePermissions(P['consolidation.manage'])
  @HttpCode(204)
  removeAdjustment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('adjustmentId', ParseUUIDPipe) adjustmentId: string,
  ) {
    return this.groups.removeAdjustment(user.organizationId, user, id, adjustmentId);
  }

  // ---------------------------------------------------- report / readiness / runs

  @Get(':id/report')
  @RequirePermissions(P['consolidation.view'])
  @ApiOperation({
    summary: 'Live group consolidation: translated members, eliminations, adjustments, CTA, NCI',
  })
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: WindowDto,
  ) {
    return this.engine.report(user.organizationId, id, query);
  }

  @Get(':id/readiness')
  @RequirePermissions(P['consolidation.view'])
  @ApiOperation({
    summary: 'Readiness checklist: members, rates, closed periods, intercompany, mappings, balance',
  })
  readiness(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: WindowDto,
  ) {
    return this.engine.readiness(user.organizationId, id, query);
  }

  @Get(':id/runs')
  @RequirePermissions(P['consolidation.view'])
  runs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListRunsQueryDto,
  ) {
    return this.engine.runs(user.organizationId, id, query);
  }

  @Post(':id/runs')
  @RequirePermissions(P['consolidation.manage'])
  @ApiOperation({ summary: 'Store a consolidation snapshot (report + readiness) as a DRAFT run' })
  createRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: WindowDto,
  ) {
    return this.engine.createRun(user.organizationId, user, id, body);
  }

  @Get(':id/runs/:runId')
  @RequirePermissions(P['consolidation.view'])
  run(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.engine.run(user.organizationId, id, runId);
  }

  @Post(':id/runs/:runId/finalize')
  @RequirePermissions(P['consolidation.manage'])
  @ApiOperation({ summary: 'Finalise a run (every readiness check must pass); audited FINALIZE' })
  finalize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.engine.finalize(user.organizationId, user, id, runId);
  }
}
