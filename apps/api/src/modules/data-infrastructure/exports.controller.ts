import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import { exportQuerySchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { PermissionDeniedError } from '@/common/errors/app-error';
import { DATASET_PERMISSION, ExportsService } from './exports.service';

class ExportQueryDto extends createZodDto(exportQuerySchema) {}

@ApiTags('Exports')
@Controller('exports')
@CompanyScoped()
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get()
  @RequirePermissions(P['reports.export'])
  @ApiOperation({
    summary:
      'Export a report or list as CSV (needs reports.export plus the dataset view permission)',
  })
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ExportQueryDto,
    @Res() res: Response,
  ) {
    const needed = DATASET_PERMISSION[query.dataset];
    if (!user.permissions.has(needed)) throw new PermissionDeniedError([needed]);
    const file = await this.exports.export(user.companyId!, user, query);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('X-Export-Rows', String(file.rows));
    res.send(file.body);
  }
}
