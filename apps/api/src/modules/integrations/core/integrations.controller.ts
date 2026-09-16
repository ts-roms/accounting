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
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P, SYNC_ENTITIES } from '@accounting/types';
import {
  createIntegrationSchema,
  listIntegrationLogsQuerySchema,
  listIntegrationsQuerySchema,
  listSyncJobsQuerySchema,
  oauthCallbackSchema,
  oauthStartSchema,
  previewMappingSchema,
  triggerSyncSchema,
  updateIntegrationSchema,
  upsertMappingSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { IntegrationHealthService } from '../health/integration-health.service';
import { IntegrationLogsService } from '../logs/integration-logs.service';
import { ExternalReferencesService } from '../mapping/external-references.service';
import { MappingsService } from '../mapping/mappings.service';
import { OAuthService } from '../oauth/oauth.service';
import { SyncService } from '../sync/sync.service';
import { InboundWebhooksService } from '../webhooks/inbound-webhooks.service';
import { IntegrationsService } from './integrations.service';

class CreateDto extends createZodDto(createIntegrationSchema) {}
class UpdateDto extends createZodDto(updateIntegrationSchema) {}
class ListDto extends createZodDto(listIntegrationsQuerySchema) {}
class SyncDto extends createZodDto(triggerSyncSchema) {}
class SyncJobsDto extends createZodDto(listSyncJobsQuerySchema) {}
class LogsDto extends createZodDto(listIntegrationLogsQuerySchema.omit({ integrationId: true })) {}
class MappingDto extends createZodDto(upsertMappingSchema) {}
class PreviewDto extends createZodDto(previewMappingSchema) {}
class OAuthStartDto extends createZodDto(oauthStartSchema) {}
class OAuthCallbackDto extends createZodDto(oauthCallbackSchema) {}
class DisconnectDto extends createZodDto(
  z.object({ reason: z.string().trim().max(500).optional() }),
) {}
class RefsDto extends createZodDto(z.object({ entityType: z.enum(SYNC_ENTITIES).optional() })) {}

/** Integration registry plus the per-integration sub-resources (sync, mappings, logs, health, OAuth). */
@ApiTags('Integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly service: IntegrationsService,
    private readonly sync: SyncService,
    private readonly mappings: MappingsService,
    private readonly refs: ExternalReferencesService,
    private readonly logs: IntegrationLogsService,
    private readonly health: IntegrationHealthService,
    private readonly oauth: OAuthService,
    private readonly inbound: InboundWebhooksService,
  ) {}

  // -------------------------------------------------------------- catalogue

  @Get('providers')
  @RequirePermissions(P['integration.view'])
  @ApiOperation({ summary: 'Connector catalogue (available providers and what they need)' })
  providers() {
    return this.service.providers();
  }

  /** Provider redirect target - public; the state parameter is the credential. */
  @Get('oauth/callback')
  @Public()
  async oauthCallback(@Query() query: OAuthCallbackDto, @Res() res: Response) {
    const { redirectTo } = await this.oauth.callback(query);
    res.redirect(302, redirectTo);
  }

  // ---------------------------------------------------------------- registry

  @Get()
  @RequirePermissions(P['integration.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDto) {
    return this.service.list(user.organizationId, query);
  }

  @Post()
  @RequirePermissions(P['integration.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateDto) {
    return this.service.create(user, body);
  }

  @Get(':id')
  @RequirePermissions(P['integration.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.organizationId, id);
  }

  @Patch(':id')
  @RequirePermissions(P['integration.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDto,
  ) {
    return this.service.update(user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['integration.manage'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(user, id);
  }

  @Post(':id/connect')
  @RequirePermissions(P['integration.manage'])
  connect(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.connect(user, id);
  }

  @Post(':id/disconnect')
  @RequirePermissions(P['integration.manage'])
  disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DisconnectDto,
  ) {
    return this.service.disconnect(user, id, body?.reason);
  }

  @Post(':id/test')
  @HttpCode(200)
  @RequirePermissions(P['integration.manage'])
  test(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.test(user, id);
  }

  // -------------------------------------------------------------------- sync

  @Post(':id/sync')
  @HttpCode(202)
  @RequirePermissions(P['integration.manage'])
  @ApiOperation({ summary: 'Queue a synchronisation job; returns the job to poll' })
  triggerSync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SyncDto,
  ) {
    return this.sync.trigger(user, user.organizationId, id, body);
  }

  @Post(':id/push')
  @HttpCode(202)
  @RequirePermissions(P['integration.manage'])
  @ApiOperation({
    summary: 'Queue an outbound push job (export -> map -> provider); returns the job to poll',
  })
  triggerPush(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SyncDto,
  ) {
    return this.sync.trigger(user, user.organizationId, id, body, 'MANUAL', 'OUTBOUND');
  }

  @Get(':id/sync-jobs')
  @RequirePermissions(P['integration.view'])
  syncJobs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: SyncJobsDto,
  ) {
    return this.sync.list(user.organizationId, id, query);
  }

  @Get(':id/sync-jobs/:jobId')
  @RequirePermissions(P['integration.view'])
  syncJob(@CurrentUser() user: AuthenticatedUser, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.sync.get(user.organizationId, jobId);
  }

  @Post(':id/sync-jobs/:jobId/cancel')
  @RequirePermissions(P['integration.manage'])
  cancelSync(@CurrentUser() user: AuthenticatedUser, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.sync.cancel(user, user.organizationId, jobId);
  }

  @Get(':id/cursors')
  @RequirePermissions(P['integration.view'])
  async cursors(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.getRow(user.organizationId, id);
    return this.sync.cursors(id);
  }

  // ---------------------------------------------------------------- mappings

  @Get(':id/mappings')
  @RequirePermissions(P['integration.view'])
  async listMappings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const row = await this.service.getRow(user.organizationId, id);
    const stored = await this.mappings.list(id);
    const descriptor = this.service.connector(row.provider).descriptor;
    return {
      mappings: stored,
      defaults: descriptor.defaultMappings ?? {},
      outboundDefaults: descriptor.defaultOutboundMappings ?? {},
    };
  }

  @Post(':id/mappings')
  @RequirePermissions(P['integration.manage'])
  async upsertMapping(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MappingDto,
  ) {
    await this.service.getRow(user.organizationId, id);
    return this.mappings.upsert(user, id, body);
  }

  @Delete(':id/mappings/:mappingId')
  @HttpCode(204)
  @RequirePermissions(P['integration.manage'])
  async removeMapping(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
  ) {
    await this.service.getRow(user.organizationId, id);
    await this.mappings.remove(user, id, mappingId);
  }

  @Post(':id/mappings/preview')
  @HttpCode(200)
  @RequirePermissions(P['integration.view'])
  async previewMapping(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PreviewDto,
  ) {
    const row = await this.service.getRow(user.organizationId, id);
    return this.mappings.preview(id, row.provider, body);
  }

  @Get(':id/external-references')
  @RequirePermissions(P['integration.view'])
  async externalReferences(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RefsDto,
  ) {
    await this.service.getRow(user.organizationId, id);
    return this.refs.list(id, query.entityType);
  }

  // ------------------------------------------------------- logs / health

  @Get(':id/logs')
  @RequirePermissions(P['integration.view'])
  async integrationLogs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: LogsDto,
  ) {
    await this.service.getRow(user.organizationId, id);
    return this.logs.list(user.organizationId, { ...query, integrationId: id });
  }

  @Get(':id/events')
  @RequirePermissions(P['integration.view'])
  async events(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.getRow(user.organizationId, id);
    return this.inbound.listEvents(user.organizationId, id);
  }

  @Get(':id/health')
  @RequirePermissions(P['integration.view'])
  async integrationHealth(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const row = await this.service.getRow(user.organizationId, id);
    return this.health.evaluate(row);
  }

  // ------------------------------------------------------------------- OAuth

  @Post(':id/oauth/start')
  @HttpCode(200)
  @RequirePermissions(P['integration.manage'])
  @ApiOperation({
    summary: 'Begin the authorisation-code flow; returns the URL to send the browser to',
  })
  oauthStart(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: OAuthStartDto,
  ) {
    return this.oauth.start(user, id, body);
  }

  @Post(':id/oauth/refresh')
  @HttpCode(200)
  @RequirePermissions(P['integration.manage'])
  async oauthRefresh(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const row = await this.service.getRow(user.organizationId, id);
    return this.oauth.refresh(row, user);
  }

  @Post(':id/oauth/disconnect')
  @HttpCode(200)
  @RequirePermissions(P['integration.manage'])
  async oauthDisconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.oauth.disconnect(user, id);
    return this.service.get(user.organizationId, id);
  }
}
