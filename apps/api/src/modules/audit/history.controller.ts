import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { fieldHistoryQuerySchema } from '@accounting/validation';
import { P } from '@accounting/types';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { AuditService } from './audit.service';

class FieldHistoryQueryDto extends createZodDto(fieldHistoryQuerySchema) {}

@ApiTags('Audit')
@Controller('history')
export class HistoryController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(P['history.view'])
  @ApiOperation({ summary: 'Field-level change history of one record (oldest first)' })
  @ApiOkResponse({ description: 'Field changes' })
  history(@CurrentUser() user: AuthenticatedUser, @Query() query: FieldHistoryQueryDto) {
    return this.audit.history(user.organizationId, query, user.companyId);
  }
}
