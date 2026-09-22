import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  assignReconciliationSchema,
  createReconciliationExceptionSchema,
  isoDateSchema,
  listReconciliationsQuerySchema,
  optionalText,
  reconciliationNotesSchema,
  resolveReconciliationExceptionSchema,
  runReconciliationSchema,
  updateAccountingPolicySchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { businessToday } from '@/common/time/clock';
import { ReconciliationsService } from './reconciliations.service';

class RunDto extends createZodDto(runReconciliationSchema) {}
class ListDto extends createZodDto(listReconciliationsQuerySchema) {}
class AssignDto extends createZodDto(assignReconciliationSchema) {}
class NotesDto extends createZodDto(reconciliationNotesSchema) {}
class ExceptionDto extends createZodDto(createReconciliationExceptionSchema) {}
class ResolveDto extends createZodDto(resolveReconciliationExceptionSchema) {}
class ApproveDto extends createZodDto(z.object({ notes: optionalText(1000) })) {}
class SummaryDto extends createZodDto(z.object({ asOf: isoDateSchema.optional() })) {}
class PolicyDto extends createZodDto(updateAccountingPolicySchema) {}

const today = businessToday;

/** Recorded subledger reconciliations with review and approval. */
@ApiTags('Reconciliation')
@Controller('reconciliations')
@CompanyScoped()
export class ReconciliationController {
  constructor(private readonly service: ReconciliationsService) {}

  @Get('summary')
  @RequirePermissions(P['reconciliation.view'])
  @ApiOperation({
    summary: 'Per-area status: latest record plus live variance (reconciliation center)',
  })
  summary(@CurrentUser() user: AuthenticatedUser, @Query() query: SummaryDto) {
    return this.service.summary(user.companyId!, query.asOf ?? today());
  }

  @Get()
  @RequirePermissions(P['reconciliation.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDto) {
    return this.service.list(user.companyId!, query);
  }

  @Post()
  @RequirePermissions(P['reconciliation.prepare'])
  @ApiOperation({ summary: 'Compute (or recompute) the reconciliation of an area as of a date' })
  run(@CurrentUser() user: AuthenticatedUser, @Body() body: RunDto) {
    return this.service.run(user.companyId!, user, body);
  }

  @Get(':id')
  @RequirePermissions(P['reconciliation.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.companyId!, id);
  }

  @Post(':id/assign')
  @RequirePermissions(P['reconciliation.prepare'])
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignDto,
  ) {
    return this.service.assign(user.companyId!, user, id, body);
  }

  @Post(':id/notes')
  @RequirePermissions(P['reconciliation.prepare'])
  notes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: NotesDto,
  ) {
    return this.service.addNotes(user.companyId!, user, id, body);
  }

  @Post(':id/exceptions')
  @RequirePermissions(P['reconciliation.prepare'])
  addException(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ExceptionDto,
  ) {
    return this.service.addException(user.companyId!, user, id, body);
  }

  @Post(':id/exceptions/:exceptionId/resolve')
  @RequirePermissions(P['reconciliation.prepare'])
  resolveException(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('exceptionId', ParseUUIDPipe) exceptionId: string,
    @Body() body: ResolveDto,
  ) {
    return this.service.resolveException(user.companyId!, user, id, exceptionId, body);
  }

  @Post(':id/approve')
  @RequirePermissions(P['reconciliation.approve'])
  @ApiOperation({
    summary: 'Approve: not the preparer; unexplained variance must be within materiality',
  })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApproveDto,
  ) {
    return this.service.approve(user.companyId!, user, id, body);
  }
}

@ApiTags('Reconciliation')
@Controller('accounting-policies')
@CompanyScoped()
export class AccountingPoliciesController {
  constructor(private readonly service: ReconciliationsService) {}

  @Get()
  @RequirePermissions(P['reconciliation.view'])
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.service.policy(user.companyId!);
  }

  @Patch()
  @RequirePermissions(P['policy.manage'])
  update(@CurrentUser() user: AuthenticatedUser, @Body() body: PolicyDto) {
    return this.service.updatePolicy(user.companyId!, user, body);
  }
}
