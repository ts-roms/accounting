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
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { Throttle } from '@nestjs/throttler';
import { OUTBOUND_EVENT_TYPES, P } from '@accounting/types';
import {
  createWebhookSchema,
  listWebhookDeliveriesQuerySchema,
  replayWebhookSchema,
  updateWebhookSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { InboundWebhooksService } from './inbound-webhooks.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';

class CreateDto extends createZodDto(createWebhookSchema) {}
class UpdateDto extends createZodDto(updateWebhookSchema) {}
class DeliveriesDto extends createZodDto(listWebhookDeliveriesQuerySchema) {}
class ReplayDto extends createZodDto(replayWebhookSchema) {}

/** Outbound subscriptions, deliveries and the inbound receiver. */
@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly outbound: OutboundWebhooksService,
    private readonly inbound: InboundWebhooksService,
  ) {}

  // ------------------------------------------------------------------ inbound

  /**
   * Public receiver: authentication is the provider signature verified by the
   * connector (see `verifyWebhook`); replays are deduplicated by event id.
   * Throttled per IP separately from the authenticated API.
   */
  @Post('inbound/:integrationId')
  @Public()
  @HttpCode(202)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({ summary: 'Receive a provider webhook (signature-authenticated)' })
  receive(
    @Param('integrationId', ParseUUIDPipe) integrationId: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: unknown,
  ) {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body ?? {});
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    return this.inbound.receive(integrationId, headers, raw, body);
  }

  @Post('inbound-events/:eventId/replay')
  @RequirePermissions(P['webhook.manage'])
  replayInbound(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ) {
    return this.inbound.replay(user.organizationId, eventId);
  }

  // ----------------------------------------------------------------- outbound

  @Get('event-types')
  @RequirePermissions(P['webhook.view'])
  eventTypes() {
    return OUTBOUND_EVENT_TYPES;
  }

  @Get('deliveries')
  @RequirePermissions(P['webhook.view'])
  deliveries(@CurrentUser() user: AuthenticatedUser, @Query() query: DeliveriesDto) {
    return this.outbound.listDeliveries(user.organizationId, query);
  }

  @Get()
  @RequirePermissions(P['webhook.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.outbound.list(user.organizationId);
  }

  @Post()
  @RequirePermissions(P['webhook.manage'])
  @ApiOperation({ summary: 'Create a subscription - the signing secret is returned once' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateDto) {
    return this.outbound.create(user, body);
  }

  @Get(':id')
  @RequirePermissions(P['webhook.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.outbound.get(user.organizationId, id);
  }

  @Patch(':id')
  @RequirePermissions(P['webhook.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDto,
  ) {
    return this.outbound.update(user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['webhook.manage'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.outbound.remove(user, id);
  }

  @Post(':id/test')
  @RequirePermissions(P['webhook.manage'])
  @ApiOperation({ summary: 'Send a signed webhook.test event and return the delivery result' })
  test(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.outbound.test(user, id);
  }

  @Post(':id/replay')
  @RequirePermissions(P['webhook.manage'])
  replay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReplayDto,
  ) {
    return this.outbound.replay(user, id, body);
  }

  @Post(':id/rotate-secret')
  @RequirePermissions(P['webhook.manage'])
  rotate(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.outbound.rotateSecret(user, id);
  }
}
