import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import { listIntegrationLogsQuerySchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { IntegrationLogsService } from './integration-logs.service';

class ListDto extends createZodDto(listIntegrationLogsQuerySchema) {}

@ApiTags('Integrations')
@Controller('integration-logs')
export class IntegrationLogsController {
  constructor(private readonly logs: IntegrationLogsService) {}

  @Get()
  @RequirePermissions(P['integration.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDto) {
    return this.logs.list(user.organizationId, query);
  }
}
