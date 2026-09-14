import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { listAuditLogsQuerySchema } from '@accounting/validation';
import { P } from '@accounting/types';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { AuditService } from './audit.service';

class ListAuditLogsQueryDto extends createZodDto(listAuditLogsQuerySchema) {}

@ApiTags('Audit')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(P['audit.view'])
  @ApiOperation({ summary: 'List audit trail entries for the caller organization' })
  @ApiOkResponse({ description: 'Paginated audit log entries' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListAuditLogsQueryDto) {
    return this.audit.list(user.organizationId, query);
  }
}
