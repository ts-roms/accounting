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
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  apDashboardQuerySchema,
  apSettingsSchema,
  billHoldSchema,
  cashRequirementsQuerySchema,
  createApAccrualSchema,
  createPaymentRunSchema,
  createVendorGroupSchema,
  grniQuerySchema,
  isoDateSchema,
  listApAccrualsQuerySchema,
  listBillHoldsQuerySchema,
  listDocumentsQuerySchema,
  listPaymentRunsQuerySchema,
  paymentRunDecisionSchema,
  releaseBillHoldSchema,
  remittanceQuerySchema,
  updatePaymentRunLinesSchema,
  updateVendorGroupSchema,
  vendorAddressSchema,
  vendorApprovalSchema,
  vendorBankAccountSchema,
  vendorContactSchema,
  vendorHoldSchema,
  vendorProfileSchema,
  vendorStatementsQuerySchema,
  createBillSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { businessToday } from '@/common/time/clock';
import { ApAccrualsService } from './ap-accruals.service';
import { ApConfigService } from './ap-config.service';
import { ApDashboardService } from './ap-dashboard.service';
import { ApIntegrityService } from './ap-integrity.service';
import { ApReportsService } from './ap-reports.service';
import { BillHoldsService } from './bill-holds.service';
import { BillsService } from './bills.service';
import { PaymentRunsService } from './payment-runs.service';
import { PayablesSweepJob } from './payables.job';
import { VendorsService } from './vendors.service';

class ApSettingsDto extends createZodDto(apSettingsSchema) {}
class CreateVendorGroupDto extends createZodDto(createVendorGroupSchema) {}
class UpdateVendorGroupDto extends createZodDto(updateVendorGroupSchema) {}
class VendorContactDto extends createZodDto(vendorContactSchema) {}
class UpdateVendorContactDto extends createZodDto(vendorContactSchema.partial()) {}
class VendorAddressDto extends createZodDto(vendorAddressSchema) {}
class UpdateVendorAddressDto extends createZodDto(vendorAddressSchema.partial()) {}
class VendorBankAccountDto extends createZodDto(vendorBankAccountSchema) {}
class UpdateVendorBankAccountDto extends createZodDto(
  vendorBankAccountSchema.partial().extend({
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    verified: z.boolean().optional(),
  }),
) {}
class VendorProfileDto extends createZodDto(vendorProfileSchema) {}
class VendorHoldDto extends createZodDto(vendorHoldSchema) {}
class VendorApprovalDto extends createZodDto(vendorApprovalSchema) {}
class ListDocumentsQueryDto extends createZodDto(listDocumentsQuerySchema) {}
class CreateCreditDto extends createZodDto(createBillSchema.omit({ documentType: true })) {}
class ListBillHoldsQueryDto extends createZodDto(listBillHoldsQuerySchema) {}
class BillHoldDto extends createZodDto(billHoldSchema) {}
class ReleaseBillHoldDto extends createZodDto(releaseBillHoldSchema) {}
class ListPaymentRunsQueryDto extends createZodDto(listPaymentRunsQuerySchema) {}
class CreatePaymentRunDto extends createZodDto(createPaymentRunSchema) {}
class UpdatePaymentRunLinesDto extends createZodDto(updatePaymentRunLinesSchema) {}
class PaymentRunDecisionDto extends createZodDto(paymentRunDecisionSchema) {}
class CancelRunDto extends createZodDto(z.object({ reason: z.string().trim().min(1).max(500) })) {}
class RemittanceQueryDto extends createZodDto(remittanceQuerySchema) {}
class ListApAccrualsQueryDto extends createZodDto(listApAccrualsQuerySchema) {}
class CreateApAccrualDto extends createZodDto(createApAccrualSchema) {}
class GrniQueryDto extends createZodDto(grniQuerySchema) {}
class ApDashboardQueryDto extends createZodDto(apDashboardQuerySchema) {}
class CashRequirementsQueryDto extends createZodDto(cashRequirementsQuerySchema) {}
class VendorStatementsQueryDto extends createZodDto(vendorStatementsQuerySchema) {}
class AsOfQueryDto extends createZodDto(z.object({ asOf: isoDateSchema.optional() })) {}

// --------------------------------------------------------------- settings

@ApiTags('Payables Settings')
@Controller('ap-settings')
@CompanyScoped()
export class ApSettingsController {
  constructor(private readonly config: ApConfigService) {}

  @Get()
  @RequirePermissions(P['vendor.view'])
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.config.settings(user.companyId!);
  }

  @Patch()
  @RequirePermissions(P['ap-settings.manage'])
  update(@CurrentUser() user: AuthenticatedUser, @Body() body: ApSettingsDto) {
    return this.config.updateSettings(user.companyId!, user, body);
  }
}

@ApiTags('Vendor Groups')
@Controller('vendor-groups')
@CompanyScoped()
export class VendorGroupsController {
  constructor(private readonly config: ApConfigService) {}

  @Get()
  @RequirePermissions(P['vendor.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.config.listVendorGroups(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['ap-settings.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateVendorGroupDto) {
    return this.config.createVendorGroup(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['ap-settings.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateVendorGroupDto,
  ) {
    return this.config.updateVendorGroup(user.companyId!, user, id, body);
  }
}

// ----------------------------------------------------------- vendor master

@ApiTags('Vendors')
@Controller('vendors/:id')
@CompanyScoped()
export class VendorMasterController {
  constructor(private readonly vendors: VendorsService) {}

  @Post('approve')
  @RequirePermissions(P['vendor.approve'])
  @ApiOperation({ summary: 'Vendor onboarding decision: approve, reject or block' })
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VendorApprovalDto,
  ) {
    return this.vendors.decide(user.companyId!, user, id, body);
  }

  @Post('hold')
  @RequirePermissions(P['vendor.approve'])
  @ApiOperation({
    summary: 'Place or lift a vendor hold (blocks new purchase orders, bills and payments)',
  })
  hold(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VendorHoldDto,
  ) {
    return this.vendors.setHold(user.companyId!, user, id, body);
  }

  @Patch('profile')
  @RequirePermissions(P['vendor.manage'])
  profile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VendorProfileDto,
  ) {
    return this.vendors.updateProfile(user.companyId!, user, id, body);
  }

  @Post('contacts')
  @RequirePermissions(P['vendor.manage'])
  addContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VendorContactDto,
  ) {
    return this.vendors.addContact(user.companyId!, id, body);
  }

  @Patch('contacts/:contactId')
  @RequirePermissions(P['vendor.manage'])
  updateContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() body: UpdateVendorContactDto,
  ) {
    return this.vendors.updateContact(user.companyId!, id, contactId, body);
  }

  @Delete('contacts/:contactId')
  @HttpCode(204)
  @RequirePermissions(P['vendor.manage'])
  async removeContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ) {
    await this.vendors.removeContact(user.companyId!, id, contactId);
  }

  @Post('addresses')
  @RequirePermissions(P['vendor.manage'])
  addAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VendorAddressDto,
  ) {
    return this.vendors.addAddress(user.companyId!, id, body);
  }

  @Patch('addresses/:addressId')
  @RequirePermissions(P['vendor.manage'])
  updateAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() body: UpdateVendorAddressDto,
  ) {
    return this.vendors.updateAddress(user.companyId!, id, addressId, body);
  }

  @Delete('addresses/:addressId')
  @HttpCode(204)
  @RequirePermissions(P['vendor.manage'])
  async removeAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    await this.vendors.removeAddress(user.companyId!, id, addressId);
  }

  @Post('bank-accounts')
  @RequirePermissions(P['vendor.manage'])
  @ApiOperation({
    summary: 'Add settlement instructions; the account number is only ever returned masked',
  })
  addBank(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VendorBankAccountDto,
  ) {
    return this.vendors.addBankAccount(user.companyId!, user, id, body);
  }

  @Patch('bank-accounts/:bankId')
  @RequirePermissions(P['vendor.manage'])
  updateBank(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bankId', ParseUUIDPipe) bankId: string,
    @Body() body: UpdateVendorBankAccountDto,
  ) {
    return this.vendors.updateBankAccount(user.companyId!, user, id, bankId, body);
  }

  @Delete('bank-accounts/:bankId')
  @HttpCode(204)
  @RequirePermissions(P['vendor.manage'])
  async removeBank(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bankId', ParseUUIDPipe) bankId: string,
  ) {
    await this.vendors.removeBankAccount(user.companyId!, user, id, bankId);
  }
}

// ---------------------------------------------------- vendor credit / debit

@ApiTags('Vendor Credits')
@Controller('vendor-credits')
@CompanyScoped()
export class VendorCreditsController {
  constructor(private readonly bills: BillsService) {}

  @Get()
  @RequirePermissions(P['bill.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDocumentsQueryDto) {
    return this.bills.list(user.companyId!, { ...query, documentType: 'CREDIT_NOTE' });
  }

  @Post()
  @RequirePermissions(P['bill.create'])
  @ApiOperation({ summary: 'Record a vendor credit memo (posts Dr AP / Cr expense when posted)' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCreditDto) {
    return this.bills.create(user.companyId!, user, { ...body, documentType: 'CREDIT_NOTE' });
  }
}

@ApiTags('Vendor Debit Notes')
@Controller('vendor-debit-notes')
@CompanyScoped()
export class VendorDebitNotesController {
  constructor(private readonly bills: BillsService) {}

  @Get()
  @RequirePermissions(P['bill.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDocumentsQueryDto) {
    return this.bills.list(user.companyId!, { ...query, documentType: 'DEBIT_NOTE' });
  }

  @Post()
  @RequirePermissions(P['bill.create'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCreditDto) {
    return this.bills.create(user.companyId!, user, { ...body, documentType: 'DEBIT_NOTE' });
  }
}

// -------------------------------------------------------------- bill holds

@ApiTags('Bill Holds')
@Controller('bill-holds')
@CompanyScoped()
export class BillHoldsController {
  constructor(private readonly holds: BillHoldsService) {}

  @Get()
  @RequirePermissions(P['bill.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListBillHoldsQueryDto) {
    return this.holds.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['bill.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.holds.get(user.companyId!, id);
  }

  @Post(':id/release')
  @RequirePermissions(P['bill.hold'])
  release(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReleaseBillHoldDto,
  ) {
    return this.holds.release(user.companyId!, user, id, body);
  }
}

@ApiTags('Bills')
@Controller('bills/:id')
@CompanyScoped()
export class BillHoldActionsController {
  constructor(private readonly holds: BillHoldsService) {}

  @Post('hold')
  @RequirePermissions(P['bill.hold'])
  @ApiOperation({
    summary: 'Place a payment hold: the bill stays posted but cannot be paid until released',
  })
  hold(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BillHoldDto,
  ) {
    return this.holds.hold(user.companyId!, user, id, body);
  }
}

// ------------------------------------------------------------ payment runs

@ApiTags('Payment Runs')
@Controller('payment-runs')
@CompanyScoped()
export class PaymentRunsController {
  constructor(private readonly runs: PaymentRunsService) {}

  @Get()
  @RequirePermissions(P['payment-run.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPaymentRunsQueryDto) {
    return this.runs.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['payment-run.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['payment-run.create'])
  @ApiOperation({
    summary: 'Propose a run: open, unheld bills by due date and / or discount window',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreatePaymentRunDto) {
    return this.runs.create(user.companyId!, user, body);
  }

  @Patch(':id/lines')
  @RequirePermissions(P['payment-run.create'])
  updateLines(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePaymentRunLinesDto,
  ) {
    return this.runs.updateLines(user.companyId!, user, id, body);
  }

  @Post(':id/submit')
  @RequirePermissions(P['payment-run.create'])
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.submit(user.companyId!, user, id);
  }

  @Post(':id/approve')
  @RequirePermissions(P['payment-run.approve'])
  @ApiOperation({ summary: 'Approve the run (delegable; segregated from the proposer)' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PaymentRunDecisionDto,
  ) {
    return this.runs.approve(user.companyId!, user, id, body);
  }

  @Post(':id/execute')
  @RequirePermissions(P['payment-run.execute'])
  @ApiOperation({
    summary:
      'Create and post one vendor payment per vendor (Dr AP / Cr cash / Cr purchase discount)',
  })
  execute(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.execute(user.companyId!, user, id);
  }

  @Post(':id/cancel')
  @RequirePermissions(P['payment-run.create'])
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelRunDto,
  ) {
    return this.runs.cancel(user.companyId!, user, id, body.reason);
  }

  @Get(':id/remittance')
  @RequirePermissions(P['payment-run.execute'])
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Remittance / bank file for an executed run (CSV or advice text)' })
  async remittance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RemittanceQueryDto,
    @Res() res: Response,
  ) {
    const file = await this.runs.remittance(user.companyId!, id, query);
    res.setHeader(
      'Content-Type',
      query.format === 'CSV' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  }
}

// ----------------------------------------------------------------- accruals

@ApiTags('AP Accruals')
@Controller('ap-accruals')
@CompanyScoped()
export class ApAccrualsController {
  constructor(private readonly accruals: ApAccrualsService) {}

  @Get()
  @RequirePermissions(P['ap-accrual.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListApAccrualsQueryDto) {
    return this.accruals.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['ap-accrual.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.accruals.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['ap-accrual.post'])
  @ApiOperation({
    summary: 'Draft a period-end accrual (received-not-billed services, or manual lines)',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateApAccrualDto) {
    return this.accruals.create(user.companyId!, user, body);
  }

  @Post(':id/post')
  @RequirePermissions(P['ap-accrual.post'])
  @ApiOperation({
    summary: 'Post Dr expense / Cr accrued expense and the auto-reversal on the reversal date',
  })
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.accruals.post(user.companyId!, user, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['ap-accrual.post'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.accruals.remove(user.companyId!, user, id);
  }
}

// ------------------------------------------------------------------ reports

@ApiTags('AP Reports')
@Controller()
@CompanyScoped()
export class ApReportsPlatformController {
  constructor(
    private readonly dashboard: ApDashboardService,
    private readonly reports: ApReportsService,
    private readonly integrity: ApIntegrityService,
    private readonly accruals: ApAccrualsService,
    private readonly sweep: PayablesSweepJob,
  ) {}

  @Get('ap-dashboard')
  @RequirePermissions(P['reports.view'])
  @ApiOperation({
    summary:
      'Executive AP dashboard: payables, aging, DPO, cash requirements, discounts, holds, GRNI',
  })
  getDashboard(@CurrentUser() user: AuthenticatedUser, @Query() query: ApDashboardQueryDto) {
    return this.dashboard.dashboard(user.companyId!, query.asOf);
  }

  @Get('cash-requirements')
  @RequirePermissions(P['payment-run.view'])
  @ApiOperation({ summary: 'Cash needed by horizon to settle open bills, with the bill detail' })
  cashRequirements(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CashRequirementsQueryDto,
  ) {
    return this.dashboard.cashRequirements(user.companyId!, query);
  }

  @Get('grni')
  @RequirePermissions(P['ap-accrual.view'])
  @ApiOperation({
    summary: 'Goods / services received but not billed, reconciled to the GRNI account',
  })
  grni(@CurrentUser() user: AuthenticatedUser, @Query() query: GrniQueryDto) {
    return this.accruals.grni(user.companyId!, query);
  }

  @Get('vendor-statements')
  @RequirePermissions(P['vendor.view'])
  @ApiOperation({ summary: 'Vendor statement for a period' })
  statement(@CurrentUser() user: AuthenticatedUser, @Query() query: VendorStatementsQueryDto) {
    return this.reports.statement(user.companyId!, query.vendorId, {
      from: query.from,
      to: query.to,
    });
  }

  @Get('ap-integrity')
  @RequirePermissions(P['integrity.check'])
  @ApiOperation({
    summary: 'AP integrity checks (subledger vs GL, holds, discounts, runs, accruals)',
  })
  integrityChecks(@CurrentUser() user: AuthenticatedUser, @Query() query: AsOfQueryDto) {
    return this.integrity.run(user.companyId!, query.asOf ?? businessToday());
  }

  @Post('payables/sweep')
  @RequirePermissions(P['ap-settings.manage'])
  @ApiOperation({
    summary: 'Run the daily payables sweep now (due-soon, discount and GRNI alerts)',
  })
  runSweep(@CurrentUser() user: AuthenticatedUser, @Query() query: AsOfQueryDto) {
    return this.sweep.sweep(user.companyId!, query.asOf);
  }
}
