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
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  bankingSettingsSchema,
  createBankAccountSchema,
  createBankTransactionSchema,
  importStatementSchema,
  listBankTransactionsQuerySchema,
  listStatementLinesQuerySchema,
  listStatementsQuerySchema,
  matchStatementLineSchema,
  queryBooleanSchema,
  updateBankAccountSchema,
  updateBankTransactionSchema,
  voidDocumentSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { BankingService } from './banking.service';
import { parseStatementFile, StatementFormatError } from './statement-formats.logic';
import { StatementsService } from './statements.service';

/** Statement files are small text; 10 MB covers a year of camt.053. */
const STATEMENT_FILE_MAX_BYTES = 10 * 1024 * 1024;

class CreateBankAccountDto extends createZodDto(createBankAccountSchema) {}
class UpdateBankAccountDto extends createZodDto(updateBankAccountSchema) {}
class ListTransactionsQueryDto extends createZodDto(listBankTransactionsQuerySchema) {}
class CreateTransactionDto extends createZodDto(createBankTransactionSchema) {}
class UpdateTransactionDto extends createZodDto(updateBankTransactionSchema) {}
class VoidDto extends createZodDto(voidDocumentSchema) {}
class SettingsDto extends createZodDto(bankingSettingsSchema) {}
class ImportStatementDto extends createZodDto(importStatementSchema) {}
class ListStatementsQueryDto extends createZodDto(listStatementsQuerySchema) {}
class ListLinesQueryDto extends createZodDto(listStatementLinesQuerySchema) {}
class MatchLineDto extends createZodDto(matchStatementLineSchema) {}
class NoteDto extends createZodDto(z.object({ note: z.string().trim().min(1).max(500) })) {}
class NotesDto extends createZodDto(z.object({ notes: z.string().trim().max(1000).optional() })) {}
class LedgerLinesQueryDto extends createZodDto(
  z.object({ onlyUnmatched: queryBooleanSchema.optional() }),
) {}

@ApiTags('Bank Accounts')
@Controller('bank-accounts')
@CompanyScoped()
export class BankAccountsController {
  constructor(private readonly banking: BankingService) {}

  @Get()
  @RequirePermissions(P['bank-account.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.banking.listAccounts(user.companyId!);
  }

  @Get('settings')
  @RequirePermissions(P['bank-account.view'])
  settings(@CurrentUser() user: AuthenticatedUser) {
    return this.banking.settings(user.companyId!);
  }

  @Put('settings')
  @RequirePermissions(P['bank-account.manage'])
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: SettingsDto) {
    return this.banking.updateSettings(user.companyId!, user, body);
  }

  @Get(':id')
  @RequirePermissions(P['bank-account.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.banking.getAccount(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['bank-account.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateBankAccountDto) {
    return this.banking.createAccount(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['bank-account.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBankAccountDto,
  ) {
    return this.banking.updateAccount(user.companyId!, user, id, body);
  }
}

@ApiTags('Bank Transactions')
@Controller('bank-transactions')
@CompanyScoped()
export class BankTransactionsController {
  constructor(private readonly banking: BankingService) {}

  @Get()
  @RequirePermissions(P['bank-account.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListTransactionsQueryDto) {
    return this.banking.listTransactions(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['bank-account.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.banking.getTransaction(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['bank-transaction.create'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateTransactionDto) {
    return this.banking.createTransaction(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['bank-transaction.create'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTransactionDto,
  ) {
    return this.banking.updateTransaction(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['bank-transaction.create'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.banking.removeTransaction(user.companyId!, id);
  }

  @Post(':id/post')
  @RequirePermissions(P['bank-transaction.post'])
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.banking.postTransaction(user.companyId!, user, id);
  }

  @Post(':id/void')
  @RequirePermissions(P['bank-transaction.post'])
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoidDto,
  ) {
    return this.banking.voidTransaction(user.companyId!, user, id, body);
  }
}

@ApiTags('Bank Statements')
@Controller('bank-statements')
@CompanyScoped()
export class BankStatementsController {
  constructor(private readonly statements: StatementsService) {}

  @Get()
  @RequirePermissions(P['bank-account.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListStatementsQueryDto) {
    return this.statements.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['bank-account.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.get(user.companyId!, id);
  }

  @Get(':id/lines')
  @RequirePermissions(P['bank-account.view'])
  lines(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListLinesQueryDto,
  ) {
    return this.statements.lines(user.companyId!, id, query);
  }

  @Get(':id/ledger-lines')
  @RequirePermissions(P['bank-account.view'])
  @ApiOperation({ summary: 'Posted ledger lines on the bank account up to the statement date' })
  ledgerLines(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: LedgerLinesQueryDto,
  ) {
    return this.statements.ledgerLines(user.companyId!, id, Boolean(query.onlyUnmatched));
  }

  @Get(':id/reconciliation')
  @RequirePermissions(P['bank-account.view'])
  reconciliation(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.reconciliation(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['bank-statement.import'])
  @ApiOperation({ summary: 'Import a statement and run the matching engine' })
  import(@CurrentUser() user: AuthenticatedUser, @Body() body: ImportStatementDto) {
    return this.statements.import(user.companyId!, user, body);
  }

  @Post('parse')
  @RequirePermissions(P['bank-statement.import'])
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: STATEMENT_FILE_MAX_BYTES, files: 1 } }),
  )
  @ApiOperation({
    summary:
      'Parse a bank statement file (MT940, camt.053, OFX / QFX) into the import shape; nothing is stored',
  })
  parse(@UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined) {
    if (!file)
      throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'A statement file is required.');
    try {
      return parseStatementFile(file.buffer.toString('utf8'));
    } catch (err) {
      if (err instanceof StatementFormatError)
        throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, err.message);
      throw err;
    }
  }

  @Post(':id/rematch')
  @RequirePermissions(P['bank-reconciliation.perform'])
  rematch(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.rematch(user.companyId!, user, id);
  }

  @Post(':id/lines/:lineId/match')
  @RequirePermissions(P['bank-reconciliation.perform'])
  match(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: MatchLineDto,
  ) {
    return this.statements.matchLine(user.companyId!, user, id, lineId, body.journalLineId);
  }

  @Post(':id/lines/:lineId/unmatch')
  @RequirePermissions(P['bank-reconciliation.perform'])
  unmatch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
  ) {
    return this.statements.unmatchLine(user.companyId!, user, id, lineId);
  }

  @Post(':id/lines/:lineId/ignore')
  @RequirePermissions(P['bank-reconciliation.perform'])
  ignore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: NoteDto,
  ) {
    return this.statements.ignoreLine(user.companyId!, user, id, lineId, body.note);
  }

  @Post(':id/complete')
  @RequirePermissions(P['bank-reconciliation.perform'])
  @ApiOperation({ summary: 'Complete the reconciliation (every line explained, balances agree)' })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: NotesDto,
  ) {
    return this.statements.complete(user.companyId!, user, id, body.notes);
  }
}
