import { Module } from '@nestjs/common';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { AuthorityService } from './authority.service';
import { DelegationExpiryJob } from './delegation-expiry.job';
import { DelegationsController } from './delegations.controller';
import { DelegationsService } from './delegations.service';

/**
 * Delegated authority. Imported by AuthModule (grant resolution for the
 * principal) and by every document module that approves something
 * (`AuthorityService.assert`). Depends only on RBAC, jobs and the global
 * audit / notification modules, so it never forms a cycle with them.
 */
@Module({
  imports: [RbacModule, JobsModule],
  controllers: [DelegationsController],
  providers: [DelegationsService, AuthorityService, DelegationExpiryJob],
  exports: [DelegationsService, AuthorityService],
})
export class DelegationsModule {}
