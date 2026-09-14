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
  agingQuerySchema,
  allocateSchema,
  collectionUpdateSchema,
  createCustomerSchema,
  createInvoiceSchema,
  createPaymentSchema,
  listDocumentsQuerySchema,
  listPartiesQuerySchema,
  listPaymentsQuerySchema,
  reconciliationQuerySchema,
  statementQuerySchema,
  updateCustomerSchema,
  updateInvoiceSchema,
  updatePaymentSchema,
  voidDocumentSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ArReportsService } from './ar-reports.service';
import { CustomerPaymentsService } from './customer-payments.service';
import { CustomersService } from './customers.service';
import { InvoicesService } from './invoices.service';

class ListPartiesQueryDto extends createZodDto(listPartiesQuerySchema) {}
class CreateCustomerDto extends createZodDto(createCustomerSchema) {}
class UpdateCustomerDto extends createZodDto(updateCustomerSchema) {}
class ListDocumentsQueryDto extends createZodDto(listDocumentsQuerySchema) {}
class CreateInvoiceDto extends createZodDto(createInvoiceSchema) {}
class UpdateInvoiceDto extends createZodDto(updateInvoiceSchema) {}
class VoidDocumentDto extends createZodDto(voidDocumentSchema) {}
class CollectionUpdateDto extends createZodDto(collectionUpdateSchema) {}
class AllocateDto extends createZodDto(allocateSchema) {}
class ListPaymentsQueryDto extends createZodDto(listPaymentsQuerySchema) {}
class CreatePaymentDto extends createZodDto(createPaymentSchema) {}
class UpdatePaymentDto extends createZodDto(updatePaymentSchema) {}
class AgingQueryDto extends createZodDto(agingQuerySchema) {}
class StatementQueryDto extends createZodDto(statementQuerySchema) {}
class ReconciliationQueryDto extends createZodDto(reconciliationQuerySchema) {}

@ApiTags('Customers')
@Controller('customers')
@CompanyScoped()
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly reports: ArReportsService,
  ) {}

  @Get()
  @RequirePermissions(P['customer.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPartiesQueryDto) {
    return this.customers.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['customer.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.getView(user.companyId!, id);
  }

  @Get(':id/statement')
  @RequirePermissions(P['customer.view'])
  @ApiOperation({ summary: 'Customer statement: opening balance, movements, running balance' })
  statement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: StatementQueryDto,
  ) {
    return this.reports.statement(user.companyId!, id, query);
  }

  @Post()
  @RequirePermissions(P['customer.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCustomerDto) {
    return this.customers.create(user.companyId!, body);
  }

  @Patch(':id')
  @RequirePermissions(P['customer.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCustomerDto,
  ) {
    return this.customers.update(user.companyId!, id, body);
  }
}

@ApiTags('Invoices')
@Controller('invoices')
@CompanyScoped()
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermissions(P['invoice.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDocumentsQueryDto) {
    return this.invoices.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['invoice.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['invoice.create'])
  @ApiOperation({ summary: 'Create a draft invoice, credit note or debit note' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateInvoiceDto) {
    return this.invoices.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['invoice.create'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateInvoiceDto,
  ) {
    return this.invoices.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @RequirePermissions(P['invoice.create'])
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.invoices.remove(user.companyId!, id);
  }

  @Post(':id/approve')
  @RequirePermissions(P['invoice.approve'])
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.approve(user.companyId!, user, id);
  }

  @Post(':id/post')
  @RequirePermissions(P['invoice.post'])
  @ApiOperation({ summary: 'Post to the ledger: Dr AR / Cr revenue (credit notes mirror)' })
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.post(user.companyId!, user, id);
  }

  @Post(':id/void')
  @RequirePermissions(P['invoice.void'])
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoidDocumentDto,
  ) {
    return this.invoices.void(user.companyId!, user, id, body);
  }

  @Patch(':id/collection')
  @RequirePermissions(P['invoice.create'])
  @ApiOperation({ summary: 'Collection tracking: promised payment date and notes' })
  collection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CollectionUpdateDto,
  ) {
    return this.invoices.updateCollection(user.companyId!, id, body);
  }

  @Post(':id/apply')
  @RequirePermissions(P['customer-payment.post'])
  @ApiOperation({ summary: 'Apply a posted credit note to open invoices' })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AllocateDto,
  ) {
    return this.invoices.applyCreditNote(user.companyId!, user, id, body, body.allocationDate);
  }
}

@ApiTags('Customer Payments')
@Controller('customer-payments')
@CompanyScoped()
export class CustomerPaymentsController {
  constructor(private readonly payments: CustomerPaymentsService) {}

  @Get()
  @RequirePermissions(P['invoice.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPaymentsQueryDto) {
    return this.payments.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['invoice.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['customer-payment.create'])
  @ApiOperation({ summary: 'Draft a receipt or refund with its allocations' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreatePaymentDto) {
    return this.payments.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['customer-payment.create'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePaymentDto,
  ) {
    return this.payments.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @RequirePermissions(P['customer-payment.create'])
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.payments.remove(user.companyId!, id);
  }

  @Post(':id/post')
  @RequirePermissions(P['customer-payment.post'])
  @ApiOperation({ summary: 'Post the receipt (Dr cash / Cr AR) and settle the allocated invoices' })
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.post(user.companyId!, user, id);
  }

  @Post(':id/allocate')
  @RequirePermissions(P['customer-payment.post'])
  allocate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AllocateDto,
  ) {
    return this.payments.allocate(user.companyId!, user, id, body, body.allocationDate);
  }

  @Post(':id/void')
  @RequirePermissions(P['customer-payment.post'])
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoidDocumentDto,
  ) {
    return this.payments.void(user.companyId!, user, id, body);
  }
}

@ApiTags('Receivables Reports')
@Controller('reports')
@CompanyScoped()
export class ArReportsController {
  constructor(private readonly reports: ArReportsService) {}

  @Get('ar-aging')
  @RequirePermissions(P['reports.view'])
  aging(@CurrentUser() user: AuthenticatedUser, @Query() query: AgingQueryDto) {
    return this.reports.aging(user.companyId!, query);
  }

  @Get('ar-reconciliation')
  @RequirePermissions(P['reports.view'])
  @ApiOperation({ summary: 'AR subledger vs AR control account in the general ledger' })
  reconciliation(@CurrentUser() user: AuthenticatedUser, @Query() query: ReconciliationQueryDto) {
    return this.reports.reconciliation(user.companyId!, query);
  }
}
