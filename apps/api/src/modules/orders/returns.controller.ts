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
  Query,
  type Type,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { PermissionKey, ReturnType } from '@accounting/types';
import {
  cancelOrderSchema,
  createReturnSchema,
  creditReturnSchema,
  listReturnsQuerySchema,
  updateReturnSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ReturnsService } from './returns.service';

class ListReturnsQueryDto extends createZodDto(listReturnsQuerySchema) {}
class CreateReturnDto extends createZodDto(createReturnSchema) {}
class UpdateReturnDto extends createZodDto(updateReturnSchema) {}
class CreditReturnDto extends createZodDto(creditReturnSchema) {}
class CancelDto extends createZodDto(cancelOrderSchema) {}

export function createReturnsController(options: {
  path: string;
  tag: string;
  type: ReturnType;
  permissions: { view: PermissionKey; create: PermissionKey; approve: PermissionKey };
}): Type<unknown> {
  @ApiTags(options.tag)
  @Controller(options.path)
  @CompanyScoped()
  class ReturnsController {
    constructor(readonly returns: ReturnsService) {}

    @Get()
    @RequirePermissions(options.permissions.view)
    list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListReturnsQueryDto) {
      return this.returns.list(user.companyId!, options.type, query);
    }

    @Get(':id')
    @RequirePermissions(options.permissions.view)
    get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.returns.get(user.companyId!, options.type, id);
    }

    @Post()
    @RequirePermissions(options.permissions.create)
    create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateReturnDto) {
      return this.returns.create(user.companyId!, user, options.type, body);
    }

    @Patch(':id')
    @RequirePermissions(options.permissions.create)
    update(
      @CurrentUser() user: AuthenticatedUser,
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: UpdateReturnDto,
    ) {
      return this.returns.update(user.companyId!, user, options.type, id, body);
    }

    @Delete(':id')
    @HttpCode(204)
    @RequirePermissions(options.permissions.create)
    async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      await this.returns.remove(user.companyId!, options.type, id);
    }

    @Post(':id/approve')
    @RequirePermissions(options.permissions.approve)
    approve(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.returns.approve(user.companyId!, user, options.type, id);
    }

    @Post(':id/credit')
    @RequirePermissions(options.permissions.approve)
    @ApiOperation({ summary: 'Issue the (draft) credit note and record the returned quantities' })
    credit(
      @CurrentUser() user: AuthenticatedUser,
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: CreditReturnDto,
    ) {
      return this.returns.credit(user.companyId!, user, options.type, id, body);
    }

    @Post(':id/cancel')
    @RequirePermissions(options.permissions.create)
    cancel(
      @CurrentUser() user: AuthenticatedUser,
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: CancelDto,
    ) {
      return this.returns.cancel(user.companyId!, user, options.type, id, body);
    }
  }
  Object.defineProperty(ReturnsController, 'name', {
    value: `${options.tag.replace(/\s/g, '')}Controller`,
  });
  return ReturnsController;
}
