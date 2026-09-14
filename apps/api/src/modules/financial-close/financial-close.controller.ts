import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  addCloseTaskSchema,
  closeDecisionSchema,
  listClosesQuerySchema,
  startCloseSchema,
  updateCloseTaskSchema,
  uuidSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { FinancialCloseService } from './financial-close.service';

class StartDto extends createZodDto(startCloseSchema) {}
class ListDto extends createZodDto(listClosesQuerySchema) {}
class TaskDto extends createZodDto(updateCloseTaskSchema) {}
class AddTaskDto extends createZodDto(addCloseTaskSchema) {}
class DecisionDto extends createZodDto(closeDecisionSchema) {}
class CancelDto extends createZodDto(z.object({ reason: z.string().trim().min(3).max(500) })) {}
class BlockersDto extends createZodDto(z.object({ fiscalPeriodId: uuidSchema })) {}

/** Financial close checklists: month / quarter / year-end with blockers and approval. */
@ApiTags('Financial Close')
@Controller('financial-closes')
@CompanyScoped()
export class FinancialCloseController {
  constructor(private readonly service: FinancialCloseService) {}

  @Get('blockers')
  @RequirePermissions(P['close.view'])
  @ApiOperation({ summary: 'Evaluate the close blockers of a period without starting a close' })
  blockers(@CurrentUser() user: AuthenticatedUser, @Query() query: BlockersDto) {
    return this.service.blockersFor(user.companyId!, query.fiscalPeriodId);
  }

  @Get()
  @RequirePermissions(P['close.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDto) {
    return this.service.list(user.companyId!, query);
  }

  @Post()
  @RequirePermissions(P['close.manage'])
  start(@CurrentUser() user: AuthenticatedUser, @Body() body: StartDto) {
    return this.service.start(user.companyId!, user, body);
  }

  @Get(':id')
  @RequirePermissions(P['close.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.companyId!, id);
  }

  @Post(':id/refresh')
  @RequirePermissions(P['close.manage'])
  refresh(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.refresh(user.companyId!, user, id);
  }

  @Patch(':id/tasks/:taskId')
  @RequirePermissions(P['close.manage'])
  updateTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: TaskDto,
  ) {
    return this.service.updateTask(user.companyId!, user, id, taskId, body);
  }

  @Post(':id/tasks')
  @RequirePermissions(P['close.manage'])
  addTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddTaskDto,
  ) {
    return this.service.addTask(user.companyId!, user, id, body);
  }

  @Post(':id/approve')
  @RequirePermissions(P['close.approve'])
  @ApiOperation({ summary: 'Management approval: every required task done, no blocking blocker' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecisionDto,
  ) {
    return this.service.approve(user.companyId!, user, id, body);
  }

  @Post(':id/complete')
  @RequirePermissions(P['period.close'])
  @ApiOperation({
    summary: 'Close the period (year for YEAR closes) and lock it when the policy says so',
  })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecisionDto,
  ) {
    return this.service.complete(user.companyId!, user, id, body);
  }

  @Post(':id/cancel')
  @RequirePermissions(P['close.manage'])
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelDto,
  ) {
    return this.service.cancel(user.companyId!, user, id, body);
  }
}
