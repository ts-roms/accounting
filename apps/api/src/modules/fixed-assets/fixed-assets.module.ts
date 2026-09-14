import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { DepreciationRunsService } from './depreciation-runs.service';
import { DepreciationJob } from './depreciation.job';
import {
  AssetCategoriesController,
  DepreciationRunsController,
  FixedAssetsController,
} from './fixed-assets.controller';
import { FixedAssetsService } from './fixed-assets.service';

/** Asset register, lifecycle postings and depreciation runs (manual and scheduled). */
@Module({
  imports: [AccountingModule, JobsModule],
  controllers: [FixedAssetsController, AssetCategoriesController, DepreciationRunsController],
  providers: [FixedAssetsService, DepreciationRunsService, DepreciationJob],
  exports: [FixedAssetsService, DepreciationRunsService],
})
export class FixedAssetsModule {}
