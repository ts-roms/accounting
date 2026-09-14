import { Module } from '@nestjs/common';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';

/**
 * Separate from IntegrationsModule so the authentication guard (AuthModule)
 * can verify API keys without importing the whole platform.
 */
@Module({
  imports: [RbacModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
