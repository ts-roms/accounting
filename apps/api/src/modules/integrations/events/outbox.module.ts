import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * Global so domain modules (accounting, receivables, ...) can write outbox
 * rows inside their transactions without depending on the integration module.
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
