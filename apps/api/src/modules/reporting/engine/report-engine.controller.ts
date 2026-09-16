import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  copyReportDefinitionSchema,
  createReportDefinitionSchema,
  listReportDefinitionsQuerySchema,
  runAdHocReportSchema,
  runReportSchema,
  updateReportDefinitionSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ReportEngineService } from './report-engine.service';

class ListReportDefinitionsQueryDto extends createZodDto(listReportDefinitionsQuerySchema) {}
class CreateReportDefinitionDto extends createZodDto(createReportDefinitionSchema) {}
class UpdateReportDefinitionDto extends createZodDto(updateReportDefinitionSchema) {}
class CopyReportDefinitionDto extends createZodDto(copyReportDefinitionSchema) {}
class RunReportDto extends createZodDto(runReportSchema) {}
class RunAdHocReportDto extends createZodDto(runAdHocReportSchema) {}

/**
 * Configurable reporting engine: saved report definitions (system + custom)
 * and their execution against the ledger. Running only needs `reports.view`;
 * editing definitions needs `report-definition.manage`.
 */
@ApiTags('Report definitions')
@Controller('report-definitions')
@CompanyScoped()
export class ReportDefinitionsController {
  constructor(private readonly service: ReportEngineService) {}

  @Get()
  @RequirePermissions(P['reports.view'])
  @ApiOperation({
    summary: 'List report definitions (system definitions are seeded on first call)',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListReportDefinitionsQueryDto) {
    return this.service.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['reports.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['report-definition.manage'])
  @ApiOperation({ summary: 'Create a custom report definition' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateReportDefinitionDto) {
    return this.service.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['report-definition.manage'])
  @ApiOperation({ summary: 'Update a definition (system layouts are read-only; copy them first)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateReportDefinitionDto,
  ) {
    return this.service.update(user.companyId!, user, id, body);
  }

  @Post(':id/copy')
  @RequirePermissions(P['report-definition.manage'])
  @ApiOperation({ summary: 'Copy a definition into a new editable custom report' })
  copy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CopyReportDefinitionDto,
  ) {
    return this.service.copy(user.companyId!, user, id, body.code, body.name);
  }

  @Post(':id/run')
  @RequirePermissions(P['reports.view'])
  @ApiOperation({
    summary:
      'Run a saved definition for a period (figures come from posted journals and approved budgets)',
  })
  run(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RunReportDto,
  ) {
    return this.service.run(user.companyId!, id, body);
  }
}

@ApiTags('Reports')
@Controller('reports')
@CompanyScoped()
export class AdHocReportController {
  constructor(private readonly service: ReportEngineService) {}

  @Post('run')
  @RequirePermissions(P['reports.view'])
  @ApiOperation({ summary: 'Run an unsaved layout (report editor preview)' })
  runAdHoc(@CurrentUser() user: AuthenticatedUser, @Body() body: RunAdHocReportDto) {
    return this.service.runAdHoc(user.companyId!, body.basis, body.layout, body.params);
  }
}
