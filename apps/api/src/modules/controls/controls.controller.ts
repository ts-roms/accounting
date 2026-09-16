import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import { controlsQuerySchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ControlsService } from './controls.service';

class ControlsQueryDto extends createZodDto(controlsQuerySchema) {}

const today = () => new Date().toISOString().slice(0, 10);

@ApiTags('Controls')
@Controller('controls')
@CompanyScoped()
export class ControlsController {
  constructor(private readonly controls: ControlsService) {}

  @Get('dashboard')
  @RequirePermissions(P['controls.view'])
  @ApiOperation({
    summary: 'Financial control dashboard: integrity, approvals, variances, suspense, close',
  })
  dashboard(@CurrentUser() user: AuthenticatedUser, @Query() query: ControlsQueryDto) {
    return this.controls.dashboard(user.companyId!, user.organizationId, query.asOf ?? today());
  }
}
