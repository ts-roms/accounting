import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { P } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { TraceService } from './trace.service';

@ApiTags('Traceability')
@Controller('trace')
@CompanyScoped()
export class TraceController {
  constructor(private readonly service: TraceService) {}

  @Get('journal/:id')
  @RequirePermissions(P['trace.view'])
  @ApiOperation({
    summary: 'Journal -> source document -> party -> related journals -> approvals -> audit trail',
  })
  journal(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.journal(user.companyId!, id);
  }

  @Get('document/:sourceId')
  @RequirePermissions(P['trace.view'])
  @ApiOperation({ summary: 'Every journal produced by one source document' })
  document(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
  ) {
    return this.service.document(user.companyId!, sourceId);
  }
}
