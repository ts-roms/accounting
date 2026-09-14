import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ATTACHMENT_ENTITY_TYPES, ATTACHMENT_MAX_BYTES, P } from '@accounting/types';
import { attachmentMetaSchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { AttachmentsService, type UploadedFile as Upload } from './attachments.service';

class MetaDto extends createZodDto(attachmentMetaSchema) {}
const entityTypeSchema = z.enum(ATTACHMENT_ENTITY_TYPES);

function parseEntityType(raw: string) {
  const parsed = entityTypeSchema.safeParse(raw.toUpperCase().replace(/-/g, '_'));
  if (!parsed.success)
    throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, `Unknown entity type ${raw}.`);
  return parsed.data;
}

@ApiTags('Attachments')
@Controller('attachments')
@CompanyScoped()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  // Declared first: 'file' must not be captured as an entity type.
  @Get('file/:id')
  @RequirePermissions(P['attachment.view'])
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const { row, stream } = await this.attachments.open(user.companyId!, id);
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Content-Length', String(row.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(row.fileName)}"`,
    );
    res.setHeader('X-Checksum-Sha256', row.sha256);
    stream.pipe(res);
  }

  @Delete('file/:id')
  @HttpCode(204)
  @RequirePermissions(P['attachment.manage'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.attachments.remove(user.companyId!, user, id);
  }

  @Get(':entityType/:entityId')
  @RequirePermissions(P['attachment.view'])
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ) {
    return this.attachments.list(user.companyId!, parseEntityType(entityType), entityId);
  }

  @Post(':entityType/:entityId')
  @RequirePermissions(P['attachment.manage'])
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload one file (field "file", optional "description")' })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 } }),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('entityType') entityType: string,
    @Param('entityId', ParseUUIDPipe) entityId: string,
    @UploadedFile() file: Upload,
    @Body() body: MetaDto,
  ) {
    return this.attachments.upload(
      user.companyId!,
      user,
      parseEntityType(entityType),
      entityId,
      file,
      body.description,
    );
  }
}
