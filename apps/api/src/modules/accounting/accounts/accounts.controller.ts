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
  createAccountSchema,
  listAccountsQuerySchema,
  setAccountMappingSchema,
  updateAccountSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { AccountsService } from './accounts.service';

class ListAccountsQueryDto extends createZodDto(listAccountsQuerySchema) {}
class CreateAccountDto extends createZodDto(createAccountSchema) {}
class UpdateAccountDto extends createZodDto(updateAccountSchema) {}
class SetAccountMappingDto extends createZodDto(setAccountMappingSchema) {}

@ApiTags('Chart of Accounts')
@Controller('accounts')
@CompanyScoped()
export class AccountsController {
  constructor(private readonly service: AccountsService) {}

  @Get()
  @RequirePermissions(P['account.view'])
  @ApiOperation({ summary: 'Chart of accounts as a depth-first ordered tree' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListAccountsQueryDto) {
    return this.service.list(user.companyId!, query);
  }

  @Get('mappings')
  @RequirePermissions(P['account.view'])
  @ApiOperation({
    summary: 'Configured account mappings (retained earnings, control accounts, ...)',
  })
  listMappings(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listMappings(user.companyId!);
  }

  @Put('mappings')
  @RequirePermissions(P['account.manage'])
  @HttpCode(204)
  async setMapping(@CurrentUser() user: AuthenticatedUser, @Body() body: SetAccountMappingDto) {
    await this.service.setMapping(user.companyId!, body);
  }

  @Get(':id')
  @RequirePermissions(P['account.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getOrThrow(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['account.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateAccountDto) {
    return this.service.create(user.companyId!, body);
  }

  @Patch(':id')
  @RequirePermissions(P['account.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAccountDto,
  ) {
    return this.service.update(user.companyId!, id, body);
  }

  @Delete(':id')
  @RequirePermissions(P['account.manage'])
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an account that has never been used (otherwise deactivate it)' })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(user.companyId!, id);
  }
}
