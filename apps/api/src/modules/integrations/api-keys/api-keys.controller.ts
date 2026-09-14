import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { API_SCOPE_DEFINITIONS, P } from '@accounting/types';
import { createApiKeySchema, rotateApiKeySchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiKeysService } from './api-keys.service';

class CreateDto extends createZodDto(createApiKeySchema) {}
class RotateDto extends createZodDto(rotateApiKeySchema) {}
class RevokeDto extends createZodDto(z.object({ reason: z.string().trim().max(500).optional() })) {}

@ApiTags('API Keys')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly service: ApiKeysService) {}

  @Get('scopes')
  @RequirePermissions(P['api-key.view'])
  @ApiOperation({ summary: 'Scope catalog with the permissions each scope carries' })
  scopes() {
    return API_SCOPE_DEFINITIONS.map(([scope, description, permissions]) => ({
      scope,
      description,
      permissions,
    }));
  }

  @Get()
  @RequirePermissions(P['api-key.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.list(user.organizationId);
  }

  @Post()
  @RequirePermissions(P['api-key.manage'])
  @ApiOperation({ summary: 'Create a key - the secret is returned once and never again' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateDto) {
    return this.service.create(user, body);
  }

  @Get(':id')
  @RequirePermissions(P['api-key.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.organizationId, id);
  }

  @Post(':id/rotate')
  @RequirePermissions(P['api-key.manage'])
  rotate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RotateDto,
  ) {
    return this.service.rotate(user, id, body);
  }

  @Delete(':id')
  @RequirePermissions(P['api-key.manage'])
  @ApiOperation({ summary: 'Revoke a key (kept for the audit trail)' })
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevokeDto,
  ) {
    return this.service.revoke(user, id, body?.reason);
  }
}
