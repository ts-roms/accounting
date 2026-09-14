import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import { generalLedgerQuerySchema } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GeneralLedgerService } from './general-ledger.service';

class GeneralLedgerQueryDto extends createZodDto(generalLedgerQuerySchema) {}

@ApiTags('General Ledger')
@Controller('general-ledger')
@CompanyScoped()
export class GeneralLedgerController {
  constructor(private readonly service: GeneralLedgerService) {}

  @Get()
  @RequirePermissions(P['journal.view'])
  @ApiOperation({
    summary: 'Posted lines of one account with opening, running and closing balances',
  })
  ledger(@CurrentUser() user: AuthenticatedUser, @Query() query: GeneralLedgerQueryDto) {
    return this.service.ledger(user.companyId!, query);
  }
}
