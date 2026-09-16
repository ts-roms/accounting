import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import { numberingPreviewQuerySchema, numberingRuleSchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { DocumentNumberingService } from './document-numbering.service';

class NumberingRuleDto extends createZodDto(numberingRuleSchema) {}
class PreviewDto extends createZodDto(numberingPreviewQuerySchema) {}

const currentYear = () => new Date().getUTCFullYear();

@ApiTags('Numbering')
@Controller('numbering-rules')
@CompanyScoped()
export class NumberingController {
  constructor(private readonly numbering: DocumentNumberingService) {}

  @Get()
  @RequirePermissions(P['numbering.view'])
  @ApiOperation({
    summary:
      'Effective numbering rule per document type (plus branch overrides) with the next number',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query('year') year?: string) {
    return this.numbering.list(user.companyId!, year ? Number(year) : currentYear());
  }

  @Get('preview')
  @RequirePermissions(P['numbering.view'])
  @ApiOperation({ summary: 'The number the next document of a type would receive (not consumed)' })
  async preview(@CurrentUser() user: AuthenticatedUser, @Query() query: PreviewDto) {
    const next = await this.numbering.preview(
      user.companyId!,
      query.documentType,
      query.branchId ?? null,
      query.year ?? currentYear(),
    );
    return { documentType: query.documentType, branchId: query.branchId ?? null, next };
  }

  @Put()
  @RequirePermissions(P['numbering.manage'])
  @ApiOperation({
    summary: 'Create or replace the rule for a document type (company-wide or per branch)',
  })
  upsert(@CurrentUser() user: AuthenticatedUser, @Body() body: NumberingRuleDto) {
    return this.numbering.upsert(user.companyId!, user, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['numbering.manage'])
  @ApiOperation({
    summary: 'Remove a configured rule (documents fall back to the company rule / default)',
  })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.numbering.remove(user.companyId!, user, id);
  }
}
