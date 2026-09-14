import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  createRoleSchema,
  setRolePermissionsSchema,
  updateRoleSchema,
  upsertSodPolicySchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { RolesService } from './roles.service';
import { SodService } from './sod.service';

class CreateRoleDto extends createZodDto(createRoleSchema) {}
class UpdateRoleDto extends createZodDto(updateRoleSchema) {}
class SetRolePermissionsDto extends createZodDto(setRolePermissionsSchema) {}
class UpsertSodPolicyDto extends createZodDto(upsertSodPolicySchema) {}

@ApiTags('Roles & Permissions')
@Controller()
export class RbacController {
  constructor(
    private readonly rolesService: RolesService,
    private readonly sodService: SodService,
  ) {}

  @Get('permissions')
  @RequirePermissions(P['role.view'])
  @ApiOperation({ summary: 'List the permission catalog' })
  listPermissions() {
    return this.rolesService.listPermissions();
  }

  @Get('roles')
  @RequirePermissions(P['role.view'])
  @ApiOperation({ summary: 'List roles with their permissions' })
  listRoles(@CurrentUser() user: AuthenticatedUser) {
    return this.rolesService.list(user.organizationId);
  }

  @Get('roles/:id')
  @RequirePermissions(P['role.view'])
  getRole(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.getWithPermissions(user.organizationId, id);
  }

  @Post('roles')
  @RequirePermissions(P['role.manage'])
  @ApiOperation({ summary: 'Create a custom role' })
  createRole(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateRoleDto) {
    return this.rolesService.create(user.organizationId, body);
  }

  @Patch('roles/:id')
  @RequirePermissions(P['role.manage'])
  updateRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRoleDto,
  ) {
    return this.rolesService.update(user.organizationId, id, body);
  }

  @Put('roles/:id/permissions')
  @RequirePermissions(P['role.manage'])
  @ApiOperation({ summary: 'Replace the permission set of a role' })
  setRolePermissions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetRolePermissionsDto,
  ) {
    return this.rolesService.setPermissions(user.organizationId, id, body);
  }

  @Get('sod-policies')
  @RequirePermissions(P['role.view'])
  @ApiOperation({ summary: 'List segregation-of-duties policies' })
  listSodPolicies(@CurrentUser() user: AuthenticatedUser) {
    return this.sodService.list(user.organizationId);
  }

  @Post('sod-policies')
  @RequirePermissions(P['sod.manage'])
  createSodPolicy(@CurrentUser() user: AuthenticatedUser, @Body() body: UpsertSodPolicyDto) {
    return this.sodService.create(user.organizationId, body);
  }

  @Put('sod-policies/:id')
  @RequirePermissions(P['sod.manage'])
  updateSodPolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpsertSodPolicyDto,
  ) {
    return this.sodService.update(user.organizationId, id, body);
  }
}
