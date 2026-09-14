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
import { z } from 'zod';
import { P } from '@accounting/types';
import {
  agingQuerySchema,
  allocateSchema,
  isoDateSchema,
  createVendorSchema,
  createBillSchema,
  createPaymentSchema,
  listDocumentsQuerySchema,
  listPartiesQuerySchema,
  listPaymentsQuerySchema,
  matchReviewSchema,
  reconciliationQuerySchema,
  statementQuerySchema,
  updateVendorSchema,
  updateBillSchema,
  updatePaymentSchema,
  voidDocumentSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApReportsService } from './ap-reports.service';
import { VendorPaymentsService } from './vendor-payments.service';
import { VendorsService } from './vendors.service';
import { BillsService } from './bills.service';

class ListPartiesQueryDto extends createZodDto(listPartiesQuerySchema) {}
class CreateVendorDto extends createZodDto(createVendorSchema) {}
class UpdateVendorDto extends createZodDto(updateVendorSchema) {}
class ListDocumentsQueryDto extends createZodDto(listDocumentsQuerySchema) {}
class CreateBillDto extends createZodDto(createBillSchema) {}
class UpdateBillDto extends createZodDto(updateBillSchema) {}
class VoidDocumentDto extends createZodDto(voidDocumentSchema) {}
class ScheduleQueryDto extends createZodDto(z.object({ to: isoDateSchema })) {}
class ScheduleDto extends createZodDto(
  z.object({ scheduledPaymentDate: isoDateSchema.nullable() }),
) {}
class AllocateDto extends createZodDto(allocateSchema) {}
class MatchReviewDto extends createZodDto(matchReviewSchema) {}
class ListPaymentsQueryDto extends createZodDto(listPaymentsQuerySchema) {}
class CreatePaymentDto extends createZodDto(createPaymentSchema) {}
class UpdatePaymentDto extends createZodDto(updatePaymentSchema) {}
class AgingQueryDto extends createZodDto(agingQuerySchema) {}
class StatementQueryDto extends createZodDto(statementQuerySchema) {}
class ReconciliationQueryDto extends createZodDto(reconciliationQuerySchema) {}

@ApiTags('Vendors')
@Controller('vendors')
@CompanyScoped()
export class VendorsController {
  constructor(
    private readonly vendors: VendorsService,
    private readonly reports: ApReportsService,
  ) {}

  @Get()
  @RequirePermissions(P['vendor.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPartiesQueryDto) {
    return this.vendors.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['vendor.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.vendors.getView(user.companyId!, id);
  }

  @Get(':id/statement')
  @RequirePermissions(P['vendor.view'])
  @ApiOperation({ summary: 'Vendor statement: opening balance, movements, running balance' })
  statement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: StatementQueryDto,
  ) {
    return this.reports.statement(user.companyId!, id, query);
  }

  @Post()
  @RequirePermissions(P['vendor.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateVendorDto) {
    return this.vendors.create(user.companyId!, body);
  }

  @Patch(':id')
  @RequirePermissions(P['vendor.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateVendorDto,
  ) {
    return this.vendors.update(user.companyId!, id, body);
  }
}

@ApiTags('Vendor Bills')
@Controller('bills')
@CompanyScoped()
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  @Get()
  @RequirePermissions(P['bill.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDocumentsQueryDto) {
    return this.bills.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['bill.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['bill.create'])
  @ApiOperation({ summary: 'Create a draft bill, credit note or debit note' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateBillDto) {
    return this.bills.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['bill.create'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBillDto,
  ) {
    return this.bills.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @RequirePermissions(P['bill.create'])
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.bills.remove(user.companyId!, id);
  }

  @Post(':id/approve')
  @RequirePermissions(P['bill.approve'])
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.approve(user.companyId!, user, id);
  }

  @Post(':id/post')
  @RequirePermissions(P['bill.post'])
  @ApiOperation({ summary: 'Post to the ledger: Dr expense lines / Cr AP (credit notes mirror)' })
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.post(user.companyId!, user, id);
  }

  @Post(':id/void')
  @RequirePermissions(P['bill.void'])
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoidDocumentDto,
  ) {
    return this.bills.void(user.companyId!, user, id, body);
  }

  @Post(':id/match-review')
  @RequirePermissions(P['bill.match-review'])
  @ApiOperation({ summary: 'Acknowledge three-way match exceptions so the bill can be paid' })
  matchReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MatchReviewDto,
  ) {
    return this.bills.reviewMatch(user.companyId!, user, id, body.note);
  }

  @Patch(':id/schedule')
  @RequirePermissions(P['bill.create'])
  @ApiOperation({ summary: 'Payment scheduling: set or clear the planned payment date' })
  schedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ScheduleDto,
  ) {
    return this.bills.updateSchedule(user.companyId!, id, body.scheduledPaymentDate);
  }

  @Post(':id/apply')
  @RequirePermissions(P['vendor-payment.post'])
  @ApiOperation({ summary: 'Apply a posted credit note to open bills' })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AllocateDto,
  ) {
    return this.bills.applyCreditNote(user.companyId!, user, id, body, body.allocationDate);
  }
}

@ApiTags('Vendor Payments')
@Controller('vendor-payments')
@CompanyScoped()
export class VendorPaymentsController {
  constructor(private readonly payments: VendorPaymentsService) {}

  @Get()
  @RequirePermissions(P['bill.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPaymentsQueryDto) {
    return this.payments.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['bill.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['vendor-payment.create'])
  @ApiOperation({ summary: 'Draft a vendor payment or refund with its allocations' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreatePaymentDto) {
    return this.payments.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['vendor-payment.create'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePaymentDto,
  ) {
    return this.payments.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @RequirePermissions(P['vendor-payment.create'])
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.payments.remove(user.companyId!, id);
  }

  @Post(':id/post')
  @RequirePermissions(P['vendor-payment.post'])
  @ApiOperation({ summary: 'Post the receipt (Dr cash / Cr AR) and settle the allocated bills' })
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.post(user.companyId!, user, id);
  }

  @Post(':id/allocate')
  @RequirePermissions(P['vendor-payment.post'])
  allocate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AllocateDto,
  ) {
    return this.payments.allocate(user.companyId!, user, id, body, body.allocationDate);
  }

  @Post(':id/void')
  @RequirePermissions(P['vendor-payment.post'])
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoidDocumentDto,
  ) {
    return this.payments.void(user.companyId!, user, id, body);
  }
}

@ApiTags('Payables Reports')
@Controller('reports')
@CompanyScoped()
export class ApReportsController {
  constructor(private readonly reports: ApReportsService) {}

  @Get('ap-aging')
  @RequirePermissions(P['reports.view'])
  aging(@CurrentUser() user: AuthenticatedUser, @Query() query: AgingQueryDto) {
    return this.reports.aging(user.companyId!, query);
  }

  @Get('ap-schedule')
  @RequirePermissions(P['reports.view'])
  @ApiOperation({ summary: 'Open bills by planned payment date up to a horizon' })
  schedule(@CurrentUser() user: AuthenticatedUser, @Query() query: ScheduleQueryDto) {
    return this.reports.schedule(user.companyId!, query.to);
  }

  @Get('ap-reconciliation')
  @RequirePermissions(P['reports.view'])
  @ApiOperation({ summary: 'AP subledger vs AP control account in the general ledger' })
  reconciliation(@CurrentUser() user: AuthenticatedUser, @Query() query: ReconciliationQueryDto) {
    return this.reports.reconciliation(user.companyId!, query);
  }
}
