import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import { isoDateSchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { IntegrityService } from './integrity.service';

class IntegrityQueryDto extends createZodDto(z.object({ asOf: isoDateSchema.optional() })) {}

@ApiTags('Integrity')
@Controller('integrity')
@CompanyScoped()
export class IntegrityController {
  constructor(private readonly integrity: IntegrityService) {}

  @Get()
  @RequirePermissions(P['integrity.check'])
  @ApiOperation({ summary: 'Run the financial integrity checks (read-only) as of a date' })
  run(@CurrentUser() user: AuthenticatedUser, @Query() query: IntegrityQueryDto) {
    return this.integrity.run(user.companyId!, query.asOf ?? new Date().toISOString().slice(0, 10));
  }
}
