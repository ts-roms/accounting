import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ATTACHMENT_MAX_BYTES, P } from '@accounting/types';
import {
  aiAnomalyScanSchema,
  aiAskSchema,
  aiClassifySchema,
  aiForecastQuerySchema,
  aiIntakeMetaSchema,
  decideAiSuggestionSchema,
  draftFromAiDocumentSchema,
  listAiAnomaliesQuerySchema,
  listAiDocumentsQuerySchema,
  optionalText,
  paginationQuerySchema,
  updateAiDocumentSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import type { UploadedFile as Upload } from '@/modules/attachments/attachments.service';
import { AiAnomalyService } from './ai-anomaly.service';
import { AiAssistantService } from './ai-assistant.service';
import { AiClassifierService } from './ai-classifier.service';
import { AiIntakeService } from './ai-intake.service';
import { AiProviderService } from './ai-provider.service';
import { OcrService } from './ocr.service';

class IntakeMetaDto extends createZodDto(aiIntakeMetaSchema) {}
class ListDocumentsDto extends createZodDto(listAiDocumentsQuerySchema) {}
class UpdateDocumentDto extends createZodDto(updateAiDocumentSchema) {}
class DraftDto extends createZodDto(draftFromAiDocumentSchema) {}
class DismissDto extends createZodDto(z.object({ reason: optionalText(500) })) {}
class ClassifyDto extends createZodDto(aiClassifySchema) {}
class ScanDto extends createZodDto(aiAnomalyScanSchema) {}
class ListAnomaliesDto extends createZodDto(listAiAnomaliesQuerySchema) {}
class DecideDto extends createZodDto(decideAiSuggestionSchema) {}
class AskDto extends createZodDto(aiAskSchema) {}
class ForecastDto extends createZodDto(aiForecastQuerySchema) {}
class PageDto extends createZodDto(paginationQuerySchema) {}

/**
 * AI assistance (Phase 9). Every route is advisory: drafts are created by the
 * ordinary services and stay drafts; flags and answers never touch the ledger.
 */
@ApiTags('AI')
@Controller('ai')
@CompanyScoped()
export class AiController {
  constructor(
    private readonly intake: AiIntakeService,
    private readonly classifier: AiClassifierService,
    private readonly anomalies: AiAnomalyService,
    private readonly assistant: AiAssistantService,
    private readonly provider: AiProviderService,
    private readonly ocr: OcrService,
  ) {}

  @Get('status')
  @RequirePermissions(P['ai.view'])
  status() {
    return {
      provider: this.provider.name,
      model: this.provider.model,
      ocr: this.ocr.name,
      advisoryOnly: true,
    };
  }

  // -------------------------------------------------------------------- intake

  @Get('intake')
  @RequirePermissions(P['ai.view'])
  listDocuments(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDocumentsDto) {
    return this.intake.list(user.companyId!, query);
  }

  @Post('intake')
  @RequirePermissions(P['ai.use'])
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a bill / receipt for extraction (field "file", optional "kind")',
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 } }),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Upload,
    @Body() body: IntakeMetaDto,
  ) {
    return this.intake.intake(user.companyId!, user, file, body.kind);
  }

  @Get('intake/:id')
  @RequirePermissions(P['ai.view'])
  getDocument(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.intake.get(user.companyId!, id);
  }

  @Patch('intake/:id')
  @RequirePermissions(P['ai.review'])
  updateDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDocumentDto,
  ) {
    return this.intake.update(user.companyId!, user, id, body);
  }

  @Post('intake/:id/draft')
  @RequirePermissions(P['ai.review'])
  @ApiOperation({
    summary: "Create a DRAFT bill or expense claim (needs that document's create permission)",
  })
  draft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DraftDto,
  ) {
    return this.intake.draft(user.companyId!, user, id, body);
  }

  @Post('intake/:id/dismiss')
  @RequirePermissions(P['ai.review'])
  dismiss(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DismissDto,
  ) {
    return this.intake.dismiss(user.companyId!, user, id, body.reason);
  }

  // ------------------------------------------------------------ classification

  @Post('classify')
  @RequirePermissions(P['ai.use'])
  @ApiOperation({ summary: 'Suggest posting accounts for a line description' })
  classify(@CurrentUser() user: AuthenticatedUser, @Body() body: ClassifyDto) {
    return this.classifier.classify(user.companyId!, body);
  }

  // ----------------------------------------------------------------- anomalies

  @Get('anomalies')
  @RequirePermissions(P['ai.view'])
  listAnomalies(@CurrentUser() user: AuthenticatedUser, @Query() query: ListAnomaliesDto) {
    return this.anomalies.list(user.companyId!, query);
  }

  @Get('anomalies/summary')
  @RequirePermissions(P['ai.view'])
  anomalySummary(@CurrentUser() user: AuthenticatedUser) {
    return this.anomalies.summary(user.companyId!);
  }

  @Post('anomalies/scan')
  @RequirePermissions(P['ai.use'])
  scan(@CurrentUser() user: AuthenticatedUser, @Body() body: ScanDto) {
    return this.anomalies.scan(user.companyId!, user, body);
  }

  @Get('anomalies/:id')
  @RequirePermissions(P['ai.view'])
  getAnomaly(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.anomalies.get(user.companyId!, id);
  }

  @Post('anomalies/:id/decide')
  @RequirePermissions(P['ai.review'])
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideDto,
  ) {
    return this.anomalies.decide(user.companyId!, user, id, body);
  }

  // ----------------------------------------------------------------- assistant

  @Post('ask')
  @RequirePermissions(P['ai.use'])
  ask(@CurrentUser() user: AuthenticatedUser, @Body() body: AskDto) {
    return this.assistant.ask(user.companyId!, user, body);
  }

  @Get('conversations')
  @RequirePermissions(P['ai.view'])
  conversations(@CurrentUser() user: AuthenticatedUser, @Query() query: PageDto) {
    return this.assistant.conversations(user.companyId!, user, query);
  }

  @Get('conversations/:id')
  @RequirePermissions(P['ai.view'])
  conversation(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistant.conversation(user.companyId!, user, id);
  }

  @Get('forecast')
  @RequirePermissions(P['ai.view'])
  forecast(@CurrentUser() user: AuthenticatedUser, @Query() query: ForecastDto) {
    return this.assistant.forecast(user.companyId!, query);
  }
}
