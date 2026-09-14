import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { CatalogService } from './catalog.service';
import { InventoryCoreModule } from './inventory-core.module';
import { InventoryReportsService } from './inventory-reports.service';
import {
  InventoryController,
  ProductCategoriesController,
  ProductsController,
  StockAdjustmentsController,
  StockCountsController,
  StockTransfersController,
  WarehousesController,
} from './inventory.controller';
import { StockDocumentsService } from './stock-documents.service';

/** Products, warehouses, stock documents and inventory reports. */
@Module({
  imports: [AccountingModule, InventoryCoreModule],
  controllers: [
    ProductsController,
    ProductCategoriesController,
    WarehousesController,
    InventoryController,
    StockAdjustmentsController,
    StockTransfersController,
    StockCountsController,
  ],
  providers: [CatalogService, StockDocumentsService, InventoryReportsService],
  exports: [CatalogService, StockDocumentsService, InventoryReportsService, InventoryCoreModule],
})
export class InventoryModule {}
