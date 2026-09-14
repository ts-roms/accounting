import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { DocumentStockService } from './document-stock.service';
import { InventoryService } from './inventory.service';

/** The stock engine (movements, layers, balances, lots, serials) shared by every stock-moving module. */
@Module({
  imports: [AccountingModule],
  providers: [InventoryService, DocumentStockService],
  exports: [InventoryService, DocumentStockService],
})
export class InventoryCoreModule {}
