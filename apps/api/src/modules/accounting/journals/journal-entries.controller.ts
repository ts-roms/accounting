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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { P } from '@accounting/types';
import {
  createJournalEntrySchema,
  listJournalEntriesQuerySchema,
  openingBalancesSchema,
  rejectJournalEntrySchema,
  correctJournalEntrySchema,
  reverseJournalEntrySchema,
  updateJournalEntrySchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { JournalEntriesService } from './journal-entries.service';

class ListJournalEntriesQueryDto extends createZodDto(listJournalEntriesQuerySchema) {}
class CreateJournalEntryDto extends createZodDto(createJournalEntrySchema) {}
class UpdateJournalEntryDto extends createZodDto(updateJournalEntrySchema) {}
class RejectJournalEntryDto extends createZodDto(rejectJournalEntrySchema) {}
class ReverseJournalEntryDto extends createZodDto(reverseJournalEntrySchema) {}
class CorrectJournalEntryDto extends createZodDto(correctJournalEntrySchema) {}
class OpeningBalancesDto extends createZodDto(openingBalancesSchema) {}

@ApiTags('Journal Entries')
@Controller('journal-entries')
@CompanyScoped()
export class JournalEntriesController {
  constructor(private readonly service: JournalEntriesService) {}

  @Get()
  @RequirePermissions(P['journal.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListJournalEntriesQueryDto) {
    return this.service.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['journal.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['journal.create'])
  @ApiOperation({ summary: 'Create a balanced draft journal entry (idempotent on idempotencyKey)' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateJournalEntryDto) {
    return this.service.create(user.companyId!, user, body);
  }

  @Post('opening-balances')
  @RequirePermissions(P['journal.create'])
  @ApiOperation({
    summary:
      'Create an OPENING journal from per-account balances; any difference is offset to the OPENING_BALANCE_EQUITY mapping',
  })
  openingBalances(@CurrentUser() user: AuthenticatedUser, @Body() body: OpeningBalancesDto) {
    return this.service.openingBalances(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['journal.create'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateJournalEntryDto,
  ) {
    return this.service.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @RequirePermissions(P['journal.create'])
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(user.companyId!, id);
  }

  @Post(':id/submit')
  @RequirePermissions(P['journal.submit'])
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.submit(user.companyId!, user, id);
  }

  @Post(':id/approve')
  @RequirePermissions(P['journal.approve'])
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.approve(user.companyId!, user, id);
  }

  @Post(':id/reject')
  @RequirePermissions(P['journal.approve'])
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RejectJournalEntryDto,
  ) {
    return this.service.reject(user.companyId!, user, id, body);
  }

  @Post(':id/post')
  @RequirePermissions(P['journal.post'])
  @ApiOperation({ summary: 'Post an approved entry to the general ledger (idempotent)' })
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.post(user.companyId!, user, id);
  }

  @Post(':id/reverse')
  @RequirePermissions(P['journal.reverse'])
  @ApiOperation({
    summary: 'Create and post a reversal; the original stays in the ledger as REVERSED',
  })
  reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReverseJournalEntryDto,
  ) {
    return this.service.reverse(user.companyId!, user, id, body);
  }

  @Post(':id/correct')
  @RequirePermissions(P['journal.correct'])
  @ApiOperation({
    summary: 'Reverse a posted entry and open a DRAFT correcting entry linked to it',
  })
  correct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CorrectJournalEntryDto,
  ) {
    return this.service.correct(user.companyId!, user, id, body);
  }
}
