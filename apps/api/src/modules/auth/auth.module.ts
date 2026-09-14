import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DelegationsModule } from '@/modules/delegations/delegations.module';
import { ApiKeysModule } from '@/modules/integrations/api-keys/api-keys.module';
import { OrganizationsModule } from '@/modules/organizations/organizations.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { UsersModule } from '@/modules/users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';

@Module({
  imports: [
    JwtModule.register({}),
    UsersModule,
    RbacModule,
    OrganizationsModule,
    ApiKeysModule,
    DelegationsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, JwtAuthGuard],
  exports: [AuthService, TokenService, JwtAuthGuard],
})
export class AuthModule {}
