import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { IMPORT_TYPES, P, type ImportType } from '@accounting/types';
import {
  commitImportSchema,
  createImportSchema,
  listImportsQuerySchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { IMPORT_SPECS, templateCsv } from './import-specs';
import { ImportsService, type ImportFile } from './imports.service';

class CreateImportDto extends createZodDto(createImportSchema) {}
class ListImportsDto extends createZodDto(listImportsQuerySchema) {}
class CommitImportDto extends createZodDto(commitImportSchema) {}

const MAX_BYTES = 5 * 1024 * 1024;

/** Static metadata: no company needed (the web loads it before a company is selected). */
@ApiTags('Imports')
@Controller('imports')
export class ImportMetadataController {
  @Get('types')
  @RequirePermissions(P['import.view'])
  @ApiOperation({ summary: 'Import types with their columns and transactional behaviour' })
  types() {
    return IMPORT_TYPES.map((t) => IMPORT_SPECS[t]).map(({ row: _row, ...spec }) => spec);
  }

  @Get('templates/:type')
  @RequirePermissions(P['import.view'])
  @ApiOperation({ summary: 'CSV template (header + example row) for an import type' })
  template(@Param('type') type: string, @Res() res: Response) {
    if (!(IMPORT_TYPES as readonly string[]).includes(type))
      throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, `Unknown import type ${type}.`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${type.toLowerCase()}-template.csv"`,
    );
    res.send(templateCsv(type as ImportType));
  }
}

@ApiTags('Imports')
@Controller('imports')
@CompanyScoped()
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get()
  @RequirePermissions(P['import.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListImportsDto) {
    return this.imports.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['import.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['import.run'])
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a CSV: parsed, validated and stored for preview (nothing is created yet)',
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: ImportFile,
    @Body() body: CreateImportDto,
  ) {
    return this.imports.upload(user.companyId!, user, body, file);
  }

  @Post(':id/commit')
  @RequirePermissions(P['import.run'])
  @ApiOperation({
    summary: 'Create the records of a validated import (atomic for financial datasets)',
  })
  commit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CommitImportDto,
  ) {
    return this.imports.commit(user.companyId!, user, id, body);
  }

  @Post(':id/cancel')
  @RequirePermissions(P['import.run'])
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.cancel(user.companyId!, user, id);
  }
}
