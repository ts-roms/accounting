import { Module } from '@nestjs/common';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

/** Document management: files attached to any business document, stored on disk with checksums. */
@Module({
  imports: [RbacModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
