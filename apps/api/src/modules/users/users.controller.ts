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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  assignUserRoleSchema,
  createUserSchema,
  listUsersQuerySchema,
  setUserStatusSchema,
  updateUserSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { RoleAssignmentService } from '@/modules/rbac/role-assignment.service';
import { UsersService, toUserView } from './users.service';

class ListUsersQueryDto extends createZodDto(listUsersQuerySchema) {}
class CreateUserDto extends createZodDto(createUserSchema) {}
class UpdateUserDto extends createZodDto(updateUserSchema) {}
class SetUserStatusDto extends createZodDto(setUserStatusSchema) {}
class AssignUserRoleDto extends createZodDto(assignUserRoleSchema) {}

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly assignments: RoleAssignmentService,
  ) {}

  @Get()
  @RequirePermissions(P['user.view'])
  @ApiOperation({ summary: 'List users (paginated)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListUsersQueryDto) {
    return this.usersService.list(user.organizationId, query);
  }

  @Get(':id')
  @RequirePermissions(P['user.view'])
  async get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return toUserView(await this.usersService.getOrThrow(user.organizationId, id));
  }

  @Post()
  @RequirePermissions(P['user.create'])
  @ApiOperation({ summary: 'Create a user and optionally assign roles' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateUserDto) {
    return this.usersService.create(user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['user.update'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserDto,
  ) {
    return this.usersService.update(user.organizationId, id, body);
  }

  @Patch(':id/status')
  @RequirePermissions(P['user.deactivate'])
  @ApiOperation({ summary: 'Activate, deactivate or lock a user' })
  setStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetUserStatusDto,
  ) {
    return this.usersService.setStatus(user.organizationId, id, body);
  }

  @Get(':id/roles')
  @RequirePermissions(P['user.view'])
  listRoles(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.listForUser(user.organizationId, id);
  }

  @Post(':id/roles')
  @RequirePermissions(P['role.assign'])
  @ApiOperation({ summary: 'Assign a role (organization-wide or company-scoped)' })
  assignRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignUserRoleDto,
  ) {
    return this.assignments.assign(user, user.organizationId, id, body);
  }

  @Delete(':id/roles/:assignmentId')
  @HttpCode(204)
  @RequirePermissions(P['role.assign'])
  async revokeRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    await this.assignments.revoke(user.organizationId, id, assignmentId);
  }
}
