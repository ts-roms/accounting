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
  createBudgetSchema,
  createBudgetVersionSchema,
  createExpenseClaimSchema,
  listBudgetsQuerySchema,
  listExpenseClaimsQuerySchema,
  payExpenseClaimSchema,
  rejectExpenseClaimSchema,
  replaceBudgetLinesSchema,
  updateBudgetSchema,
  updateExpenseClaimSchema,
  uuidSchema,
  varianceQuerySchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { BudgetsService } from './budgets.service';
import { ExpenseClaimsService } from './expense-claims.service';

class CreateBudgetDto extends createZodDto(createBudgetSchema) {}
class UpdateBudgetDto extends createZodDto(updateBudgetSchema) {}
class ListBudgetsQueryDto extends createZodDto(listBudgetsQuerySchema) {}
class CreateVersionDto extends createZodDto(createBudgetVersionSchema) {}
class ReplaceLinesDto extends createZodDto(replaceBudgetLinesSchema) {}
class VarianceQueryDto extends createZodDto(varianceQuerySchema.extend({ versionId: uuidSchema.optional() })) {}
class CreateClaimDto extends createZodDto(createExpenseClaimSchema) {}
class UpdateClaimDto extends createZodDto(updateExpenseClaimSchema) {}
class ListClaimsQueryDto extends createZodDto(listExpenseClaimsQuerySchema) {}
class RejectClaimDto extends createZodDto(rejectExpenseClaimSchema) {}
class PayClaimDto extends createZodDto(payExpenseClaimSchema) {}
class ReasonDto extends createZodDto(z.object({ reason: z.string().trim().min(1).max(500) })) {}

@ApiTags('Budgets')
@Controller('budgets')
@CompanyScoped()
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @RequirePermissions(P['budget.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListBudgetsQueryDto) {
    return this.budgets.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['budget.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['budget.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateBudgetDto) {
    return this.budgets.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['budget.manage'])
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBudgetDto) {
    return this.budgets.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['budget.manage'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.budgets.remove(user.companyId!, id);
  }

  @Get(':id/variance')
  @RequirePermissions(P['budget.view'])
  @ApiOperation({ summary: 'Budget vs actual per account and period (approved version by default)' })
  variance(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Query() query: VarianceQueryDto) {
    const { versionId, ...rest } = query;
    return this.budgets.variance(user.companyId!, id, versionId, rest);
  }

  @Post(':id/versions')
  @RequirePermissions(P['budget.manage'])
  createVersion(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateVersionDto) {
    return this.budgets.createVersion(user.companyId!, user, id, body);
  }

  @Get(':id/versions/:versionId')
  @RequirePermissions(P['budget.view'])
  getVersion(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.budgets.getVersion(user.companyId!, id, versionId);
  }

  @Put(':id/versions/:versionId/lines')
  @RequirePermissions(P['budget.manage'])
  @ApiOperation({ summary: 'Replace every line of a draft version' })
  replaceLines(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string, @Body() body: ReplaceLinesDto) {
    return this.budgets.replaceLines(user.companyId!, user, id, versionId, body);
  }

  @Post(':id/versions/:versionId/approve')
  @RequirePermissions(P['budget.approve'])
  approveVersion(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.budgets.approveVersion(user.companyId!, user, id, versionId);
  }

  @Delete(':id/versions/:versionId')
  @HttpCode(204)
  @RequirePermissions(P['budget.manage'])
  async removeVersion(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string) {
    await this.budgets.removeVersion(user.companyId!, id, versionId);
  }
}

@ApiTags('Expense Claims')
@Controller('expense-claims')
@CompanyScoped()
export class ExpenseClaimsController {
  constructor(private readonly claims: ExpenseClaimsService) {}

  @Get()
  @RequirePermissions(P['expense-claim.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListClaimsQueryDto) {
    return this.claims.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['expense-claim.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.claims.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['expense-claim.create'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateClaimDto) {
    return this.claims.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['expense-claim.create'])
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateClaimDto) {
    return this.claims.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['expense-claim.create'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.claims.remove(user.companyId!, id);
  }

  @Post(':id/submit')
  @RequirePermissions(P['expense-claim.create'])
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.claims.submit(user.companyId!, user, id);
  }

  @Post(':id/approve')
  @RequirePermissions(P['expense-claim.approve'])
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.claims.approve(user.companyId!, user, id);
  }

  @Post(':id/reject')
  @RequirePermissions(P['expense-claim.approve'])
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: RejectClaimDto) {
    return this.claims.reject(user.companyId!, user, id, body.reason);
  }

  @Post(':id/cancel')
  @RequirePermissions(P['expense-claim.create'])
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.claims.cancel(user.companyId!, user, id, body.reason);
  }

  @Post(':id/post')
  @RequirePermissions(P['expense-claim.post'])
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.claims.post(user.companyId!, user, id);
  }

  @Post(':id/pay')
  @RequirePermissions(P['expense-claim.post'])
  pay(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: PayClaimDto) {
    return this.claims.pay(user.companyId!, user, id, body);
  }
}
