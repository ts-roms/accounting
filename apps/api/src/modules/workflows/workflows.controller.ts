import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  createWorkflowSchema,
  decideApprovalSchema,
  listApprovalsQuerySchema,
  updateWorkflowSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApprovalsService } from './approvals.service';

class CreateWorkflowDto extends createZodDto(createWorkflowSchema) {}
class UpdateWorkflowDto extends createZodDto(updateWorkflowSchema) {}
class ListApprovalsQueryDto extends createZodDto(listApprovalsQuerySchema) {}
class DecideDto extends createZodDto(decideApprovalSchema) {}

@ApiTags('Approval Workflows')
@Controller('approval-workflows')
@CompanyScoped()
export class WorkflowsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermissions(P['approval.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.approvals.listWorkflows(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['workflow.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateWorkflowDto) {
    return this.approvals.createWorkflow(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['workflow.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWorkflowDto,
  ) {
    return this.approvals.updateWorkflow(user.companyId!, user, id, body);
  }
}

@ApiTags('Approvals')
@Controller('approvals')
@CompanyScoped()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermissions(P['approval.view'])
  @ApiOperation({
    summary: 'Approval requests; mine=true lists only those the caller can decide now',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListApprovalsQueryDto) {
    return this.approvals.list(user.companyId!, user, query);
  }

  @Get(':id')
  @RequirePermissions(P['approval.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.get(user.companyId!, user, id);
  }

  @Post(':id/decide')
  @RequirePermissions(P['approval.decide'])
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideDto,
  ) {
    return this.approvals.decide(user.companyId!, user, id, body);
  }
}
