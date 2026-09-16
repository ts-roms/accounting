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
  type Type,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';
import type { OrderType, PermissionKey } from '@accounting/types';
import {
  cancelOrderSchema,
  convertOrderSchema,
  createOrderSchema,
  fulfilOrderSchema,
  listOrdersQuerySchema,
  rejectOrderSchema,
  updateOrderSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { OrdersService } from './orders.service';
import type { OrderAction } from './orders.logic';

class ListOrdersQueryDto extends createZodDto(listOrdersQuerySchema) {}
class UpdateOrderDto extends createZodDto(updateOrderSchema) {}
class RejectOrderDto extends createZodDto(rejectOrderSchema) {}
class CancelOrderDto extends createZodDto(cancelOrderSchema) {}
class ConvertOrderDto extends createZodDto(convertOrderSchema) {}
class FulfilOrderDto extends createZodDto(fulfilOrderSchema) {}

export interface OrderControllerOptions {
  path: string;
  tag: string;
  type: OrderType;
  /** Type-specific create schema (customer / vendor requirements). */
  createSchema: z.ZodType<z.output<typeof createOrderSchema>, unknown>;
  permissions: { view: PermissionKey; create: PermissionKey; approve?: PermissionKey };
  /** Which lifecycle actions are exposed, with the permission each needs. */
  actions: Partial<Record<Exclude<OrderAction, 'convert'>, PermissionKey>>;
  convert?: PermissionKey;
  /** Raises an invoice (sales order) or bill (purchase order). */
  fulfil?: { permission: PermissionKey; summary: string };
}

/**
 * Builds a REST controller for one order type. The four order types share the
 * service; only the path, permissions and available actions differ.
 */
export function createOrderController(options: OrderControllerOptions): Type<unknown> {
  class CreateOrderDto extends createZodDto(options.createSchema) {}
  const actions = options.actions;

  @ApiTags(options.tag)
  @Controller(options.path)
  @CompanyScoped()
  class OrderController {
    constructor(readonly orders: OrdersService) {}

    @Get()
    @RequirePermissions(options.permissions.view)
    list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListOrdersQueryDto) {
      return this.orders.list(user.companyId!, options.type, query);
    }

    @Get(':id')
    @RequirePermissions(options.permissions.view)
    get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.orders.get(user.companyId!, options.type, id);
    }

    @Post()
    @RequirePermissions(options.permissions.create)
    create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateOrderDto) {
      return this.orders.create(user.companyId!, user, options.type, body);
    }

    @Patch(':id')
    @RequirePermissions(options.permissions.create)
    update(
      @CurrentUser() user: AuthenticatedUser,
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: UpdateOrderDto,
    ) {
      return this.orders.update(user.companyId!, user, options.type, id, body);
    }

    @Delete(':id')
    @HttpCode(204)
    @RequirePermissions(options.permissions.create)
    async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      await this.orders.remove(user.companyId!, options.type, id);
    }

    @Post(':id/submit')
    @RequirePermissions(actions.submit ?? options.permissions.create)
    submit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.run(user, id, 'submit');
    }

    @Post(':id/send')
    @RequirePermissions(actions.send ?? options.permissions.create)
    send(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.run(user, id, 'send');
    }

    @Post(':id/accept')
    @RequirePermissions(actions.accept ?? options.permissions.create)
    accept(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.run(user, id, 'accept');
    }

    @Post(':id/approve')
    @RequirePermissions(
      actions.approve ?? options.permissions.approve ?? options.permissions.create,
    )
    approve(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.run(user, id, 'approve');
    }

    @Post(':id/reject')
    @RequirePermissions(actions.reject ?? options.permissions.approve ?? options.permissions.create)
    reject(
      @CurrentUser() user: AuthenticatedUser,
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: RejectOrderDto,
    ) {
      return this.run(user, id, 'reject', body);
    }

    @Post(':id/confirm')
    @RequirePermissions(actions.confirm ?? options.permissions.create)
    @ApiOperation({ summary: 'Confirm an approved sales order with the customer' })
    confirm(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.run(user, id, 'confirm');
    }

    @Post(':id/close')
    @RequirePermissions(actions.close ?? options.permissions.create)
    close(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.run(user, id, 'close');
    }

    @Post(':id/cancel')
    @RequirePermissions(actions.cancel ?? options.permissions.create)
    cancel(
      @CurrentUser() user: AuthenticatedUser,
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: CancelOrderDto,
    ) {
      return this.run(user, id, 'cancel', body);
    }

    @Post(':id/convert')
    @RequirePermissions(options.convert ?? options.permissions.create)
    @ApiOperation({
      summary:
        'Convert into the follow-on order (quotation -> sales order, request -> purchase order)',
    })
    convert(
      @CurrentUser() user: AuthenticatedUser,
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: ConvertOrderDto,
    ) {
      return this.orders.convert(user.companyId!, user, options.type, id, body);
    }

    @Post(':id/fulfil')
    @RequirePermissions(options.fulfil?.permission ?? options.permissions.create)
    @ApiOperation({ summary: options.fulfil?.summary ?? 'Not available for this order type' })
    fulfil(
      @CurrentUser() user: AuthenticatedUser,
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: FulfilOrderDto,
    ) {
      return this.orders.fulfil(user.companyId!, user, options.type, id, body);
    }

    private run(
      user: AuthenticatedUser,
      id: string,
      action: Exclude<OrderAction, 'convert'>,
      body?: RejectOrderDto | CancelOrderDto,
    ) {
      return this.orders.transition(user.companyId!, user, options.type, id, action, body);
    }
  }

  // Give each generated controller a distinct name for Nest's DI and Swagger.
  Object.defineProperty(OrderController, 'name', {
    value: `${options.tag.replace(/\s/g, '')}Controller`,
  });
  return OrderController;
}
