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
  type Type,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P, type PermissionKey, type StockDocumentType } from '@accounting/types';
import {
  cancelOrderSchema,
  createAdjustmentSchema,
  createCountSchema,
  createLocationSchema,
  createProductCategorySchema,
  createProductSchema,
  createTransferSchema,
  createWarehouseSchema,
  inventorySettingsSchema,
  listProductsQuerySchema,
  listStockDocumentsQuerySchema,
  stockCardQuerySchema,
  stockOnHandQuerySchema,
  updateProductCategorySchema,
  updateProductSchema,
  updateStockDocumentSchema,
  updateWarehouseSchema,
  valuationQuerySchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { CatalogService } from './catalog.service';
import { InventoryReportsService } from './inventory-reports.service';
import { InventoryService } from './inventory.service';
import { StockDocumentsService } from './stock-documents.service';

class ListProductsQueryDto extends createZodDto(listProductsQuerySchema) {}
class CreateProductDto extends createZodDto(createProductSchema) {}
class UpdateProductDto extends createZodDto(updateProductSchema) {}
class CreateCategoryDto extends createZodDto(createProductCategorySchema) {}
class UpdateCategoryDto extends createZodDto(updateProductCategorySchema) {}
class CreateWarehouseDto extends createZodDto(createWarehouseSchema) {}
class UpdateWarehouseDto extends createZodDto(updateWarehouseSchema) {}
class CreateLocationDto extends createZodDto(createLocationSchema) {}
class InventorySettingsDto extends createZodDto(inventorySettingsSchema) {}
class StockOnHandQueryDto extends createZodDto(stockOnHandQuerySchema) {}
class StockCardQueryDto extends createZodDto(stockCardQuerySchema.omit({ productId: true })) {}
class ValuationQueryDto extends createZodDto(valuationQuerySchema) {}
class ListStockDocumentsQueryDto extends createZodDto(listStockDocumentsQuerySchema) {}
class UpdateStockDocumentDto extends createZodDto(updateStockDocumentSchema) {}
class CancelDto extends createZodDto(cancelOrderSchema) {}

@ApiTags('Products')
@Controller('products')
@CompanyScoped()
export class ProductsController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly reports: InventoryReportsService,
  ) {}

  @Get()
  @RequirePermissions(P['product.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListProductsQueryDto) {
    return this.catalog.listProducts(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['product.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getProduct(user.companyId!, id);
  }

  @Get(':id/stock-card')
  @RequirePermissions(P['inventory.view'])
  @ApiOperation({ summary: 'Movement ledger of one product with running balances' })
  stockCard(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: StockCardQueryDto,
  ) {
    return this.reports.stockCard(user.companyId!, { ...query, productId: id });
  }

  @Post()
  @RequirePermissions(P['product.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateProductDto) {
    return this.catalog.createProduct(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['product.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateProductDto,
  ) {
    return this.catalog.updateProduct(user.companyId!, user, id, body);
  }
}

@ApiTags('Product Categories')
@Controller('product-categories')
@CompanyScoped()
export class ProductCategoriesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermissions(P['product.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.catalog.listCategories(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['product.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCategoryDto) {
    return this.catalog.createCategory(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['product.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCategoryDto,
  ) {
    return this.catalog.updateCategory(user.companyId!, user, id, body);
  }
}

@ApiTags('Warehouses')
@Controller('warehouses')
@CompanyScoped()
export class WarehousesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermissions(P['inventory.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.catalog.listWarehouses(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['warehouse.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateWarehouseDto) {
    return this.catalog.createWarehouse(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['warehouse.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWarehouseDto,
  ) {
    return this.catalog.updateWarehouse(user.companyId!, user, id, body);
  }

  @Post(':id/locations')
  @RequirePermissions(P['warehouse.manage'])
  addLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateLocationDto,
  ) {
    return this.catalog.addLocation(user.companyId!, id, body);
  }
}

@ApiTags('Inventory')
@Controller('inventory')
@CompanyScoped()
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly reports: InventoryReportsService,
  ) {}

  @Get('settings')
  @RequirePermissions(P['inventory.view'])
  settings(@CurrentUser() user: AuthenticatedUser) {
    return this.inventory.settings(user.companyId!);
  }

  @Put('settings')
  @RequirePermissions(P['inventory-settings.manage'])
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: InventorySettingsDto) {
    return this.inventory.updateSettings(user.companyId!, user, body);
  }

  @Get('stock-on-hand')
  @RequirePermissions(P['inventory.view'])
  stockOnHand(@CurrentUser() user: AuthenticatedUser, @Query() query: StockOnHandQueryDto) {
    return this.reports.stockOnHand(user.companyId!, query);
  }

  @Get('valuation')
  @RequirePermissions(P['inventory.view'])
  @ApiOperation({ summary: 'Inventory subledger vs. inventory control account(s)' })
  valuation(@CurrentUser() user: AuthenticatedUser, @Query() query: ValuationQueryDto) {
    return this.reports.valuation(user.companyId!, query);
  }
}

/** One controller per stock document type; the service is shared. */
export function createStockDocumentsController(options: {
  path: string;
  tag: string;
  type: StockDocumentType;
  createSchema: z.ZodTypeAny;
  permissions: { view: PermissionKey; create: PermissionKey; post: PermissionKey };
}): Type<unknown> {
  class CreateDto extends createZodDto(options.createSchema as z.ZodObject<z.ZodRawShape>) {}

  @ApiTags(options.tag)
  @Controller(options.path)
  @CompanyScoped()
  class StockDocumentsController {
    constructor(readonly documents: StockDocumentsService) {}

    @Get()
    @RequirePermissions(options.permissions.view)
    list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListStockDocumentsQueryDto) {
      return this.documents.list(user.companyId!, options.type, query);
    }

    @Get(':id')
    @RequirePermissions(options.permissions.view)
    get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.documents.get(user.companyId!, options.type, id);
    }

    @Post()
    @RequirePermissions(options.permissions.create)
    create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateDto) {
      const companyId = user.companyId!;
      if (options.type === 'ADJUSTMENT')
        return this.documents.createAdjustment(companyId, user, body as never);
      if (options.type === 'TRANSFER')
        return this.documents.createTransfer(companyId, user, body as never);
      return this.documents.createCount(companyId, user, body as never);
    }

    @Patch(':id')
    @RequirePermissions(options.permissions.create)
    update(
      @CurrentUser() user: AuthenticatedUser,
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: UpdateStockDocumentDto,
    ) {
      return this.documents.update(user.companyId!, user, options.type, id, body);
    }

    @Delete(':id')
    @HttpCode(204)
    @RequirePermissions(options.permissions.create)
    async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      await this.documents.remove(user.companyId!, options.type, id);
    }

    @Post(':id/post')
    @RequirePermissions(options.permissions.post)
    @ApiOperation({ summary: 'Move the stock and post the journal (idempotent)' })
    post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
      return this.documents.post(user.companyId!, user, options.type, id);
    }

    @Post(':id/cancel')
    @RequirePermissions(options.permissions.create)
    cancel(
      @CurrentUser() user: AuthenticatedUser,
      @Param('id', ParseUUIDPipe) id: string,
      @Body() body: CancelDto,
    ) {
      return this.documents.cancel(user.companyId!, user, options.type, id, body);
    }
  }
  Object.defineProperty(StockDocumentsController, 'name', {
    value: `${options.tag.replace(/\s/g, '')}Controller`,
  });
  return StockDocumentsController;
}

const STOCK_PERMISSIONS = {
  view: P['inventory.view'],
  create: P['inventory.adjust'],
  post: P['inventory.post'],
};

export const StockAdjustmentsController = createStockDocumentsController({
  path: 'stock-adjustments',
  tag: 'Stock Adjustments',
  type: 'ADJUSTMENT',
  createSchema: createAdjustmentSchema,
  permissions: STOCK_PERMISSIONS,
});
export const StockTransfersController = createStockDocumentsController({
  path: 'stock-transfers',
  tag: 'Stock Transfers',
  type: 'TRANSFER',
  createSchema: createTransferSchema,
  permissions: STOCK_PERMISSIONS,
});
export const StockCountsController = createStockDocumentsController({
  path: 'stock-counts',
  tag: 'Stock Counts',
  type: 'COUNT',
  createSchema: createCountSchema,
  permissions: STOCK_PERMISSIONS,
});
