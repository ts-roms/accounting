import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  bankAccountProfileSchema,
  cashForecastQuerySchema,
  cashPositionQuerySchema,
  createBankTransferSchema,
  createForecastItemSchema,
  createPaymentFileSchema,
  createPettyCashFundSchema,
  createPettyCashVoucherSchema,
  isoDateSchema,
  listBankTransfersQuerySchema,
  listPaymentFilesQuerySchema,
  listPettyCashVouchersQuerySchema,
  paginationQuerySchema,
  paymentFileStatusSchema,
  queryBooleanSchema,
  replenishPettyCashSchema,
  settleBankTransferSchema,
  treasurySettingsSchema,
  updateForecastItemSchema,
  updatePettyCashFundSchema,
  updatePettyCashVoucherSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { BankTransfersService } from './bank-transfers.service';
import { CashForecastService } from './cash-forecast.service';
import { CashPositionService } from './cash-position.service';
import { PaymentFilesService } from './payment-files.service';
import { PettyCashService } from './petty-cash.service';
import { TreasuryConfigService } from './treasury-config.service';
import { TreasuryDashboardService } from './treasury-dashboard.service';
import { TreasuryIntegrityService } from './treasury-integrity.service';
import { TreasurySweepJob } from './treasury.job';

class TreasurySettingsDto extends createZodDto(treasurySettingsSchema) {}
class BankAccountProfileDto extends createZodDto(bankAccountProfileSchema) {}
class CashPositionQueryDto extends createZodDto(cashPositionQuerySchema) {}
class CashForecastQueryDto extends createZodDto(cashForecastQuerySchema) {}
class AsOfQueryDto extends createZodDto(z.object({ asOf: isoDateSchema.optional() })) {}
class ForecastItemsQueryDto extends createZodDto(
  paginationQuerySchema.extend({ activeOnly: queryBooleanSchema.optional() }),
) {}
class CreateForecastItemDto extends createZodDto(createForecastItemSchema) {}
class UpdateForecastItemDto extends createZodDto(updateForecastItemSchema) {}
class ListBankTransfersQueryDto extends createZodDto(listBankTransfersQuerySchema) {}
class CreateBankTransferDto extends createZodDto(createBankTransferSchema) {}
class SettleBankTransferDto extends createZodDto(settleBankTransferSchema) {}
class ReasonDto extends createZodDto(z.object({ reason: z.string().trim().min(1).max(500) })) {}
class VoidDto extends createZodDto(
  z.object({ reason: z.string().trim().min(1).max(500), voidDate: isoDateSchema.optional() }),
) {}
class ListPaymentFilesQueryDto extends createZodDto(listPaymentFilesQuerySchema) {}
class CreatePaymentFileDto extends createZodDto(createPaymentFileSchema) {}
class PaymentFileStatusDto extends createZodDto(paymentFileStatusSchema) {}
class CreatePettyCashFundDto extends createZodDto(createPettyCashFundSchema) {}
class UpdatePettyCashFundDto extends createZodDto(updatePettyCashFundSchema) {}
class ListPettyCashVouchersQueryDto extends createZodDto(listPettyCashVouchersQuerySchema) {}
class CreatePettyCashVoucherDto extends createZodDto(createPettyCashVoucherSchema) {}
class UpdatePettyCashVoucherDto extends createZodDto(updatePettyCashVoucherSchema) {}
class ReplenishPettyCashDto extends createZodDto(replenishPettyCashSchema) {}

// -------------------------------------------------------------- treasury core

@ApiTags('Treasury')
@Controller('treasury')
@CompanyScoped()
export class TreasuryController {
  constructor(
    private readonly config: TreasuryConfigService,
    private readonly positions: CashPositionService,
    private readonly forecasts: CashForecastService,
    private readonly dashboard: TreasuryDashboardService,
    private readonly integrity: TreasuryIntegrityService,
    private readonly sweep: TreasurySweepJob,
  ) {}

  @Get('dashboard')
  @RequirePermissions(P['treasury.view'])
  @ApiOperation({
    summary:
      'Cash KPIs: position, days cash on hand, forecast, reconciliation backlog, transfers, petty cash',
  })
  getDashboard(@CurrentUser() user: AuthenticatedUser, @Query() query: AsOfQueryDto) {
    return this.dashboard.dashboard(user.companyId!, query.asOf);
  }

  @Get('position')
  @RequirePermissions(P['treasury.view'])
  @ApiOperation({
    summary:
      'Cash position per bank account (GL book balance, statement, unreconciled, in transit)',
  })
  position(@CurrentUser() user: AuthenticatedUser, @Query() query: CashPositionQueryDto) {
    return this.positions.position(user.companyId!, query);
  }

  @Get('forecast')
  @RequirePermissions(P['treasury.view'])
  @ApiOperation({
    summary:
      'Rolling cash forecast from open AR / AP, payment runs, transfers, recurring journals and planned items',
  })
  forecast(@CurrentUser() user: AuthenticatedUser, @Query() query: CashForecastQueryDto) {
    return this.forecasts.forecast(user.companyId!, query, user);
  }

  @Get('forecast/snapshots')
  @RequirePermissions(P['treasury.view'])
  snapshots(@CurrentUser() user: AuthenticatedUser) {
    return this.forecasts.snapshots(user.companyId!);
  }

  @Get('forecast/items')
  @RequirePermissions(P['treasury.view'])
  listItems(@CurrentUser() user: AuthenticatedUser, @Query() query: ForecastItemsQueryDto) {
    return this.forecasts.listItems(user.companyId!, query);
  }

  @Post('forecast/items')
  @RequirePermissions(P['treasury.forecast-manage'])
  createItem(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateForecastItemDto) {
    return this.forecasts.createItem(user.companyId!, user, body);
  }

  @Patch('forecast/items/:id')
  @RequirePermissions(P['treasury.forecast-manage'])
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateForecastItemDto,
  ) {
    return this.forecasts.updateItem(user.companyId!, user, id, body);
  }

  @Delete('forecast/items/:id')
  @HttpCode(204)
  @RequirePermissions(P['treasury.forecast-manage'])
  removeItem(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.forecasts.removeItem(user.companyId!, user, id);
  }

  @Get('settings')
  @RequirePermissions(P['treasury.view'])
  settings(@CurrentUser() user: AuthenticatedUser) {
    return this.config.settings(user.companyId!);
  }

  @Put('settings')
  @RequirePermissions(P['treasury-settings.manage'])
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: TreasurySettingsDto) {
    return this.config.updateSettings(user.companyId!, user, body);
  }

  @Get('bank-accounts/:id/profile')
  @RequirePermissions(P['treasury.view'])
  profile(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.config.profile(user.companyId!, id);
  }

  @Put('bank-accounts/:id/profile')
  @RequirePermissions(P['treasury-settings.manage'])
  @ApiOperation({
    summary: 'Treasury profile of a bank account (type, limits, payment file details, defaults)',
  })
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BankAccountProfileDto,
  ) {
    return this.config.updateProfile(user.companyId!, user, id, body);
  }

  @Get('integrity')
  @RequirePermissions(P['treasury.view'])
  @ApiOperation({
    summary:
      'Treasury integrity checks (in-transit vs ledger, petty cash vs imprest, payment file totals, statement drift)',
  })
  runIntegrity(@CurrentUser() user: AuthenticatedUser, @Query() query: AsOfQueryDto) {
    return this.integrity.run(user.companyId!, query.asOf ?? new Date().toISOString().slice(0, 10));
  }

  @Post('sweep')
  @RequirePermissions(P['treasury-settings.manage'])
  @ApiOperation({
    summary:
      'Run the daily treasury sweep now (minimum balances, forecast shortfall, unsettled transfers, petty cash)',
  })
  runSweep(@CurrentUser() user: AuthenticatedUser, @Query() query: AsOfQueryDto) {
    return this.sweep.sweep(user.companyId!, query.asOf);
  }
}

// ------------------------------------------------------------ bank transfers

@ApiTags('Treasury')
@Controller('treasury/transfers')
@CompanyScoped()
export class BankTransfersController {
  constructor(private readonly transfers: BankTransfersService) {}

  @Get()
  @RequirePermissions(P['treasury.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListBankTransfersQueryDto) {
    return this.transfers.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['treasury.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['bank-transfer.create'])
  @ApiOperation({ summary: 'Draft an inter-account transfer (same or cross currency)' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateBankTransferDto) {
    return this.transfers.create(user.companyId!, user, body);
  }

  @Post(':id/submit')
  @RequirePermissions(P['bank-transfer.create'])
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.submit(user.companyId!, user, id);
  }

  @Post(':id/approve')
  @RequirePermissions(P['bank-transfer.approve'])
  @ApiOperation({
    summary: 'Approve the transfer (delegable; segregated from the creator above the threshold)',
  })
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.approve(user.companyId!, user, id);
  }

  @Post(':id/send')
  @RequirePermissions(P['bank-transfer.post'])
  @ApiOperation({ summary: 'Send: Dr cash in transit / Cr source bank (+ fee)' })
  send(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.send(user.companyId!, user, id);
  }

  @Post(':id/settle')
  @RequirePermissions(P['bank-transfer.post'])
  @ApiOperation({ summary: 'Settle: Dr destination bank / Cr cash in transit (+ realized FX)' })
  settle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SettleBankTransferDto,
  ) {
    return this.transfers.settle(user.companyId!, user, id, body);
  }

  @Post(':id/cancel')
  @RequirePermissions(P['bank-transfer.create'])
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return this.transfers.cancel(user.companyId!, user, id, body.reason);
  }
}

// ------------------------------------------------------------- payment files

@ApiTags('Treasury')
@Controller('treasury/payment-files')
@CompanyScoped()
export class PaymentFilesController {
  constructor(private readonly files: PaymentFilesService) {}

  @Get()
  @RequirePermissions(P['treasury.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPaymentFilesQueryDto) {
    return this.files.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['treasury.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.files.get(user.companyId!, id);
  }

  @Get(':id/download')
  @RequirePermissions(P['payment-file.manage'])
  @Header('Cache-Control', 'no-store')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const file = await this.files.content(user.companyId!, id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  }

  @Post()
  @RequirePermissions(P['payment-file.manage'])
  @ApiOperation({
    summary:
      'Generate a bank payment file for posted vendor payments (PESONet CSV, ISO 20022 pain.001, positive pay)',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreatePaymentFileDto) {
    return this.files.create(user.companyId!, user, body);
  }

  @Post(':id/status')
  @RequirePermissions(P['payment-file.manage'])
  @ApiOperation({
    summary: 'Record the bank handshake: transmitted, acknowledged, rejected or cancelled',
  })
  setStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PaymentFileStatusDto,
  ) {
    return this.files.setStatus(user.companyId!, user, id, body);
  }
}

// ---------------------------------------------------------------- petty cash

@ApiTags('Treasury')
@Controller('treasury/petty-cash')
@CompanyScoped()
export class PettyCashController {
  constructor(private readonly pettyCash: PettyCashService) {}

  @Get('funds')
  @RequirePermissions(P['treasury.view'])
  listFunds(@CurrentUser() user: AuthenticatedUser) {
    return this.pettyCash.listFunds(user.companyId!);
  }

  @Get('funds/:id')
  @RequirePermissions(P['treasury.view'])
  getFund(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pettyCash.getFund(user.companyId!, id);
  }

  @Post('funds')
  @RequirePermissions(P['treasury-settings.manage'])
  @ApiOperation({
    summary: 'Create an imprest fund with its own cash-on-hand GL account and custodian',
  })
  createFund(@CurrentUser() user: AuthenticatedUser, @Body() body: CreatePettyCashFundDto) {
    return this.pettyCash.createFund(user.companyId!, user, body);
  }

  @Patch('funds/:id')
  @RequirePermissions(P['treasury-settings.manage'])
  updateFund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePettyCashFundDto,
  ) {
    return this.pettyCash.updateFund(user.companyId!, user, id, body);
  }

  @Post('funds/:id/replenish')
  @RequirePermissions(P['petty-cash.post'])
  @ApiOperation({
    summary:
      'Replenish from a bank account (Dr petty cash / Cr bank) and mark posted vouchers reimbursed',
  })
  replenish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReplenishPettyCashDto,
  ) {
    return this.pettyCash.replenish(user.companyId!, user, id, body);
  }

  @Get('vouchers')
  @RequirePermissions(P['treasury.view'])
  listVouchers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPettyCashVouchersQueryDto,
  ) {
    return this.pettyCash.listVouchers(user.companyId!, query);
  }

  @Get('vouchers/:id')
  @RequirePermissions(P['treasury.view'])
  getVoucher(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pettyCash.getVoucher(user.companyId!, id);
  }

  @Post('vouchers')
  @RequirePermissions(P['petty-cash.manage'])
  createVoucher(@CurrentUser() user: AuthenticatedUser, @Body() body: CreatePettyCashVoucherDto) {
    return this.pettyCash.createVoucher(user.companyId!, user, body);
  }

  @Patch('vouchers/:id')
  @RequirePermissions(P['petty-cash.manage'])
  updateVoucher(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePettyCashVoucherDto,
  ) {
    return this.pettyCash.updateVoucher(user.companyId!, user, id, body);
  }

  @Post('vouchers/:id/submit')
  @RequirePermissions(P['petty-cash.manage'])
  @ApiOperation({
    summary: 'Submit a voucher for approval (opens the workflow when one is configured)',
  })
  submitVoucher(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pettyCash.submitVoucher(user.companyId!, user, id);
  }

  @Post('vouchers/:id/approve')
  @RequirePermissions(P['petty-cash.approve'])
  @ApiOperation({
    summary: 'Approve a voucher (delegable; segregated from the preparer above the fund limit)',
  })
  approveVoucher(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pettyCash.approveVoucher(user.companyId!, user, id);
  }

  @Post('vouchers/:id/post')
  @RequirePermissions(P['petty-cash.post'])
  @ApiOperation({ summary: 'Post: Dr expense lines / Cr petty cash fund' })
  postVoucher(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pettyCash.postVoucher(user.companyId!, user, id);
  }

  @Post('vouchers/:id/void')
  @RequirePermissions(P['petty-cash.post'])
  voidVoucher(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoidDto,
  ) {
    return this.pettyCash.voidVoucher(user.companyId!, user, id, body.reason, body.voidDate);
  }
}
