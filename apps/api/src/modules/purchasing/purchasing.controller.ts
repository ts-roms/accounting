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
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  cancelOrderSchema,
  createGoodsReceiptSchema,
  listGoodsReceiptsQuerySchema,
  purchasingSettingsSchema,
  updateGoodsReceiptSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GoodsReceiptsService } from '@/modules/orders/goods-receipts.service';
import { MatchingService } from '@/modules/orders/matching.service';

class ListGoodsReceiptsQueryDto extends createZodDto(listGoodsReceiptsQuerySchema) {}
class CreateGoodsReceiptDto extends createZodDto(createGoodsReceiptSchema) {}
class UpdateGoodsReceiptDto extends createZodDto(updateGoodsReceiptSchema) {}
class CancelDto extends createZodDto(cancelOrderSchema) {}
class PurchasingSettingsDto extends createZodDto(purchasingSettingsSchema) {}

@ApiTags('Goods Receipts')
@Controller('goods-receipts')
@CompanyScoped()
export class GoodsReceiptsController {
  constructor(private readonly receipts: GoodsReceiptsService) {}

  @Get()
  @RequirePermissions(P['goods-receipt.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListGoodsReceiptsQueryDto) {
    return this.receipts.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['goods-receipt.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.receipts.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['goods-receipt.create'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateGoodsReceiptDto) {
    return this.receipts.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['goods-receipt.create'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateGoodsReceiptDto,
  ) {
    return this.receipts.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['goods-receipt.create'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.receipts.remove(user.companyId!, id);
  }

  @Post(':id/confirm')
  @RequirePermissions(P['goods-receipt.create'])
  @ApiOperation({
    summary: 'Confirm receipt: updates PO received quantities and re-matches its bills',
  })
  confirm(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.receipts.confirm(user.companyId!, user, id);
  }

  @Post(':id/cancel')
  @RequirePermissions(P['goods-receipt.create'])
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelDto,
  ) {
    return this.receipts.cancel(user.companyId!, user, id, body);
  }
}

@ApiTags('Purchasing Settings')
@Controller('purchasing/settings')
@CompanyScoped()
export class PurchasingSettingsController {
  constructor(private readonly matching: MatchingService) {}

  @Get()
  @RequirePermissions(P['purchase-order.view'])
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.matching.settings(user.companyId!);
  }

  @Put()
  @RequirePermissions(P['purchasing-settings.manage'])
  update(@CurrentUser() user: AuthenticatedUser, @Body() body: PurchasingSettingsDto) {
    return this.matching.updateSettings(user.companyId!, user, body);
  }
}
