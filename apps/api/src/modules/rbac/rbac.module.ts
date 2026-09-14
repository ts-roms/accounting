import { Module } from '@nestjs/common';
import { PermissionResolverService } from './permission-resolver.service';
import { PermissionsGuard } from './permissions.guard';
import { RbacController } from './rbac.controller';
import { RoleAssignmentService } from './role-assignment.service';
import { RolesService } from './roles.service';
import { SodService } from './sod.service';

@Module({
  controllers: [RbacController],
  providers: [
    PermissionResolverService,
    RolesService,
    SodService,
    RoleAssignmentService,
    PermissionsGuard,
  ],
  exports: [
    PermissionResolverService,
    RolesService,
    SodService,
    RoleAssignmentService,
    PermissionsGuard,
  ],
})
export class RbacModule {}
