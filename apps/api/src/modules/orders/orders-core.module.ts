import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { OrderFulfillmentService } from './order-fulfillment.service';

/**
 * Shared by the AR/AP subledgers and the sales/purchasing modules: order-line
 * fulfilment counters and three-way matching. Has no dependency on the
 * subledger services, which keeps the module graph acyclic.
 */
@Module({
  providers: [OrderFulfillmentService, MatchingService],
  exports: [OrderFulfillmentService, MatchingService],
})
export class OrdersCoreModule {}
