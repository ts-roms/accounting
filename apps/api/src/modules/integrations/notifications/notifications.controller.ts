import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { NOTIFICATION_EVENT_TYPES, P } from '@accounting/types';
import { listNotificationsQuerySchema, notificationPolicySchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { NotificationsService } from './notifications.service';

class ListDto extends createZodDto(listNotificationsQuerySchema) {}
class PolicyDto extends createZodDto(notificationPolicySchema) {}
class EventTypeDto extends createZodDto(
  z.object({ eventType: z.enum(NOTIFICATION_EVENT_TYPES) }),
) {}

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  @RequirePermissions(P['notification.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDto) {
    return this.service.list(user, query);
  }

  @Get('unread-count')
  @RequirePermissions(P['notification.view'])
  async unread(@CurrentUser() user: AuthenticatedUser) {
    return { count: await this.service.unreadCount(user.id) };
  }

  @Post('read-all')
  @HttpCode(200)
  @RequirePermissions(P['notification.view'])
  async readAll(@CurrentUser() user: AuthenticatedUser) {
    return { updated: await this.service.markAllRead(user.id) };
  }

  @Post(':id/read')
  @HttpCode(204)
  @RequirePermissions(P['notification.view'])
  async read(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.markRead(user.id, id);
  }

  @Get('policies')
  @RequirePermissions(P['organization.view'])
  policies(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listPolicies(user.organizationId);
  }

  @Put('policies/:eventType')
  @RequirePermissions(P['organization.manage'])
  upsertPolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: EventTypeDto,
    @Body() body: PolicyDto,
  ) {
    return this.service.upsertPolicy(user, params.eventType, body);
  }
}
