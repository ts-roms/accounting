import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { HistoryController } from './history.controller';
import { AuditService } from './audit.service';

/** Global so any module can record audit events without importing it. */
@Global()
@Module({
  controllers: [AuditController, HistoryController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
