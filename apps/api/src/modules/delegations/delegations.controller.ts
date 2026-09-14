import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { DELEGABLE_PERMISSION_DEFINITIONS, P } from '@accounting/types';
import {
  createDelegationSchema,
  decideDelegationSchema,
  delegationPolicySchema,
  listDelegationsQuerySchema,
  revokeDelegationSchema,
  updateDelegationSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { DelegationsService } from './delegations.service';

class CreateDto extends createZodDto(createDelegationSchema) {}
class UpdateDto extends createZodDto(updateDelegationSchema) {}
class DecideDto extends createZodDto(decideDelegationSchema) {}
class RevokeDto extends createZodDto(revokeDelegationSchema) {}
class ListDto extends createZodDto(listDelegationsQuerySchema) {}
class PolicyDto extends createZodDto(delegationPolicySchema) {}

@ApiTags('Delegated Authority')
@Controller('delegations')
export class DelegationsController {
  constructor(private readonly service: DelegationsService) {}

  @Get('permissions')
  @RequirePermissions(P['delegation.view'])
  @ApiOperation({ summary: 'Permissions that may be delegated (approval-type only)' })
  permissions() {
    return DELEGABLE_PERMISSION_DEFINITIONS.map(([permission, label, area]) => ({
      permission,
      label,
      area,
    }));
  }

  @Get('policy')
  @RequirePermissions(P['delegation.view'])
  policy(@CurrentUser() user: AuthenticatedUser) {
    return this.service.policy(user.organizationId);
  }

  @Put('policy')
  @RequirePermissions(P['delegation.manage'])
  updatePolicy(@CurrentUser() user: AuthenticatedUser, @Body() body: PolicyDto) {
    return this.service.updatePolicy(user, body);
  }

  @Get('active')
  @RequirePermissions(P['delegation.view'])
  active(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDto) {
    return this.service.list(user, { ...query, status: 'ACTIVE' });
  }

  @Get('pending')
  @RequirePermissions(P['delegation.view'])
  pending(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDto) {
    return this.service.list(user, { ...query, status: 'PENDING' });
  }

  @Get('my-authority')
  @RequirePermissions(P['delegation.view'])
  @ApiOperation({
    summary: 'Grants lent to the caller in the active company (what the approval UI shows)',
  })
  myAuthority(@CurrentUser() user: AuthenticatedUser) {
    return user.delegations ?? [];
  }

  @Get()
  @RequirePermissions(P['delegation.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDto) {
    return this.service.list(user, query);
  }

  @Post()
  @RequirePermissions(P['delegation.create'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateDto) {
    return this.service.create(user, body);
  }

  @Get(':id')
  @RequirePermissions(P['delegation.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user, id);
  }

  @Patch(':id')
  @RequirePermissions(P['delegation.create'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDto,
  ) {
    return this.service.update(user, id, body);
  }

  @Post(':id/approve')
  @RequirePermissions(P['delegation.view'])
  @ApiOperation({ summary: 'Approve or reject (eligibility follows the organization policy)' })
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideDto,
  ) {
    return this.service.decide(user, id, body);
  }

  @Post(':id/revoke')
  @RequirePermissions(P['delegation.view'])
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevokeDto,
  ) {
    return this.service.revoke(user, id, body);
  }

  @Post(':id/cancel')
  @RequirePermissions(P['delegation.view'])
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(user, id);
  }

  @Get(':id/usage')
  @RequirePermissions(P['delegation.view'])
  usage(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.usage(user, id);
  }
}
