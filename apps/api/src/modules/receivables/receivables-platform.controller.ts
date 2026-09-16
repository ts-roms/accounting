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
  arDashboardQuerySchema,
  arSettingsSchema,
  collectionActivitySchema,
  createCollectionCaseSchema,
  createCreditRuleSchema,
  createCustomerGroupSchema,
  createDeliverySchema,
  createDisputeSchema,
  createDunningPolicySchema,
  createInvoiceSchema,
  createPaymentTermSchema,
  createPromiseSchema,
  createProvisionRunSchema,
  createRefundRequestSchema,
  createWriteOffSchema,
  creditHoldSchema,
  creditProfileSchema,
  customerAddressSchema,
  customerContactSchema,
  customerStatementsQuerySchema,
  deliveryActionSchema,
  isoDateSchema,
  listCollectionCasesQuerySchema,
  listCustomerStatementsQuerySchema,
  listDeliveriesQuerySchema,
  listDisputesQuerySchema,
  listDocumentsQuerySchema,
  listPromisesQuerySchema,
  listRefundsQuerySchema,
  listWriteOffsQuerySchema,
  payRefundSchema,
  reconciliationQuerySchema,
  recoverWriteOffSchema,
  refundDecisionSchema,
  updateCollectionCaseSchema,
  updateCreditRuleSchema,
  updateCustomerGroupSchema,
  updateDeliverySchema,
  updateDisputeSchema,
  updateDunningPolicySchema,
  updatePaymentTermSchema,
  updatePromiseSchema,
  writeOffDecisionSchema,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { CompanyScoped } from '@/common/decorators/company-scoped.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ArConfigService } from './ar-config.service';
import { ArDashboardService } from './ar-dashboard.service';
import { ArIntegrityService } from './ar-integrity.service';
import { ArReportsService } from './ar-reports.service';
import { CollectionsService } from './collections.service';
import { CreditService } from './credit.service';
import { CustomersService } from './customers.service';
import { DeliveriesService } from './deliveries.service';
import { DisputesService } from './disputes.service';
import { InvoicesService } from './invoices.service';
import { RefundsService } from './refunds.service';
import { WriteOffsService } from './write-offs.service';

class ArSettingsDto extends createZodDto(arSettingsSchema) {}
class CreatePaymentTermDto extends createZodDto(createPaymentTermSchema) {}
class UpdatePaymentTermDto extends createZodDto(updatePaymentTermSchema) {}
class CreateCustomerGroupDto extends createZodDto(createCustomerGroupSchema) {}
class UpdateCustomerGroupDto extends createZodDto(updateCustomerGroupSchema) {}
class CreateCreditRuleDto extends createZodDto(createCreditRuleSchema) {}
class UpdateCreditRuleDto extends createZodDto(updateCreditRuleSchema) {}
class CreateDunningPolicyDto extends createZodDto(createDunningPolicySchema) {}
class UpdateDunningPolicyDto extends createZodDto(updateDunningPolicySchema) {}
class CustomerContactDto extends createZodDto(customerContactSchema) {}
class UpdateCustomerContactDto extends createZodDto(customerContactSchema.partial()) {}
class CustomerAddressDto extends createZodDto(customerAddressSchema) {}
class UpdateCustomerAddressDto extends createZodDto(customerAddressSchema.partial()) {}
class CreditProfileDto extends createZodDto(creditProfileSchema) {}
class CreditHoldDto extends createZodDto(creditHoldSchema) {}
class ListDeliveriesQueryDto extends createZodDto(listDeliveriesQuerySchema) {}
class CreateDeliveryDto extends createZodDto(createDeliverySchema) {}
class UpdateDeliveryDto extends createZodDto(updateDeliverySchema) {}
class DeliveryActionDto extends createZodDto(deliveryActionSchema) {}
class ListDocumentsQueryDto extends createZodDto(listDocumentsQuerySchema) {}
class CreateNoteDto extends createZodDto(createInvoiceSchema.omit({ documentType: true })) {}
class ListRefundsQueryDto extends createZodDto(listRefundsQuerySchema) {}
class CreateRefundDto extends createZodDto(createRefundRequestSchema) {}
class RefundDecisionDto extends createZodDto(refundDecisionSchema) {}
class PayRefundDto extends createZodDto(payRefundSchema) {}
class ListCasesQueryDto extends createZodDto(listCollectionCasesQuerySchema) {}
class CreateCaseDto extends createZodDto(createCollectionCaseSchema) {}
class UpdateCaseDto extends createZodDto(updateCollectionCaseSchema) {}
class ActivityDto extends createZodDto(collectionActivitySchema) {}
class ListPromisesQueryDto extends createZodDto(listPromisesQuerySchema) {}
class CreatePromiseDto extends createZodDto(createPromiseSchema) {}
class UpdatePromiseDto extends createZodDto(updatePromiseSchema) {}
class ListDisputesQueryDto extends createZodDto(listDisputesQuerySchema) {}
class CreateDisputeDto extends createZodDto(createDisputeSchema) {}
class UpdateDisputeDto extends createZodDto(updateDisputeSchema) {}
class ListWriteOffsQueryDto extends createZodDto(listWriteOffsQuerySchema) {}
class CreateWriteOffDto extends createZodDto(createWriteOffSchema) {}
class WriteOffDecisionDto extends createZodDto(writeOffDecisionSchema) {}
class PostWriteOffDto extends createZodDto(z.object({ writeOffDate: isoDateSchema.optional() })) {}
class RecoverWriteOffDto extends createZodDto(recoverWriteOffSchema) {}
class CreateProvisionDto extends createZodDto(createProvisionRunSchema) {}
class ReverseProvisionDto extends createZodDto(
  z.object({ reversalDate: isoDateSchema, reason: z.string().trim().min(1).max(500) }),
) {}
class AgingQueryDto extends createZodDto(agingQuerySchema) {}
class ReconciliationQueryDto extends createZodDto(reconciliationQuerySchema) {}
class DashboardQueryDto extends createZodDto(arDashboardQuerySchema) {}
class StatementsQueryDto extends createZodDto(customerStatementsQuerySchema) {}
class ListStatementsQueryDto extends createZodDto(listCustomerStatementsQuerySchema) {}
class SweepDto extends createZodDto(z.object({ asOf: isoDateSchema.optional() })) {}

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- settings

@ApiTags('AR Settings')
@Controller('ar-settings')
@CompanyScoped()
export class ArSettingsController {
  constructor(private readonly config: ArConfigService) {}

  @Get()
  @RequirePermissions(P['customer.view'])
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.config.settings(user.companyId!);
  }

  @Patch()
  @RequirePermissions(P['ar-settings.manage'])
  update(@CurrentUser() user: AuthenticatedUser, @Body() body: ArSettingsDto) {
    return this.config.updateSettings(user.companyId!, user, body);
  }
}

@ApiTags('Payment Terms')
@Controller('payment-terms')
@CompanyScoped()
export class PaymentTermsController {
  constructor(private readonly config: ArConfigService) {}

  @Get()
  @RequirePermissions(P['customer.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.config.listPaymentTerms(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['ar-settings.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreatePaymentTermDto) {
    return this.config.createPaymentTerm(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['ar-settings.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePaymentTermDto,
  ) {
    return this.config.updatePaymentTerm(user.companyId!, user, id, body);
  }
}

@ApiTags('Customer Groups')
@Controller('customer-groups')
@CompanyScoped()
export class CustomerGroupsController {
  constructor(private readonly config: ArConfigService) {}

  @Get()
  @RequirePermissions(P['customer.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.config.listCustomerGroups(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['ar-settings.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCustomerGroupDto) {
    return this.config.createCustomerGroup(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['ar-settings.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCustomerGroupDto,
  ) {
    return this.config.updateCustomerGroup(user.companyId!, user, id, body);
  }
}

@ApiTags('Credit Rules')
@Controller('credit-rules')
@CompanyScoped()
export class CreditRulesController {
  constructor(private readonly config: ArConfigService) {}

  @Get()
  @RequirePermissions(P['customer.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.config.listCreditRules(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['ar-settings.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCreditRuleDto) {
    return this.config.createCreditRule(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['ar-settings.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCreditRuleDto,
  ) {
    return this.config.updateCreditRule(user.companyId!, user, id, body);
  }
}

@ApiTags('Dunning Policies')
@Controller('dunning-policies')
@CompanyScoped()
export class DunningPoliciesController {
  constructor(private readonly config: ArConfigService) {}

  @Get()
  @RequirePermissions(P['collection.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.config.listDunningPolicies(user.companyId!);
  }

  @Post()
  @RequirePermissions(P['ar-settings.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateDunningPolicyDto) {
    return this.config.createDunningPolicy(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['ar-settings.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDunningPolicyDto,
  ) {
    return this.config.updateDunningPolicy(user.companyId!, user, id, body);
  }
}

// --------------------------------------------------- customer sub-resources

@ApiTags('Customers')
@Controller('customers/:id')
@CompanyScoped()
export class CustomerMasterController {
  constructor(
    private readonly customers: CustomersService,
    private readonly credit: CreditService,
  ) {}

  @Get('credit')
  @RequirePermissions(P['customer.view'])
  @ApiOperation({
    summary: 'Credit limit, used, available, overdue and status (derived from the subledger)',
  })
  creditSummary(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.credit.summary(user.companyId!, id);
  }

  @Patch('credit')
  @RequirePermissions(P['customer.credit-manage'])
  updateCredit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreditProfileDto,
  ) {
    return this.credit.updateProfile(user.companyId!, user, id, body);
  }

  @Post('credit-hold')
  @RequirePermissions(P['customer.credit-manage'])
  @ApiOperation({
    summary: 'Place the customer on credit hold or release it (audited, notifies credit managers)',
  })
  creditHold(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreditHoldDto,
  ) {
    return this.credit.hold(user.companyId!, user, id, body);
  }

  @Post('contacts')
  @RequirePermissions(P['customer.manage'])
  addContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CustomerContactDto,
  ) {
    return this.customers.addContact(user.companyId!, id, body);
  }

  @Patch('contacts/:contactId')
  @RequirePermissions(P['customer.manage'])
  updateContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() body: UpdateCustomerContactDto,
  ) {
    return this.customers.updateContact(user.companyId!, id, contactId, body);
  }

  @Delete('contacts/:contactId')
  @HttpCode(204)
  @RequirePermissions(P['customer.manage'])
  async removeContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ) {
    await this.customers.removeContact(user.companyId!, id, contactId);
  }

  @Post('addresses')
  @RequirePermissions(P['customer.manage'])
  addAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CustomerAddressDto,
  ) {
    return this.customers.addAddress(user.companyId!, id, body);
  }

  @Patch('addresses/:addressId')
  @RequirePermissions(P['customer.manage'])
  updateAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() body: UpdateCustomerAddressDto,
  ) {
    return this.customers.updateAddress(user.companyId!, id, addressId, body);
  }

  @Delete('addresses/:addressId')
  @HttpCode(204)
  @RequirePermissions(P['customer.manage'])
  async removeAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    await this.customers.removeAddress(user.companyId!, id, addressId);
  }
}

// -------------------------------------------------------------- deliveries

@ApiTags('Deliveries')
@Controller('deliveries')
@CompanyScoped()
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  @RequirePermissions(P['delivery.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDeliveriesQueryDto) {
    return this.deliveries.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['delivery.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['delivery.manage'])
  @ApiOperation({
    summary: 'Draft a delivery for the outstanding (or given) quantities of a sales order',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateDeliveryDto) {
    return this.deliveries.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['delivery.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDeliveryDto,
  ) {
    return this.deliveries.update(user.companyId!, user, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(P['delivery.manage'])
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.deliveries.remove(user.companyId!, id);
  }

  @Post(':id/pick')
  @RequirePermissions(P['delivery.manage'])
  pick(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryActionDto,
  ) {
    return this.deliveries.transition(user.companyId!, user, id, 'pick', body);
  }

  @Post(':id/ready')
  @RequirePermissions(P['delivery.manage'])
  ready(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryActionDto,
  ) {
    return this.deliveries.transition(user.companyId!, user, id, 'ready', body);
  }

  @Post(':id/deliver')
  @RequirePermissions(P['delivery.manage'])
  @ApiOperation({
    summary:
      'Goods leave: stock issued through the inventory engine, COGS posted through the gateway',
  })
  deliver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryActionDto,
  ) {
    return this.deliveries.transition(user.companyId!, user, id, 'deliver', body);
  }

  @Post(':id/cancel')
  @RequirePermissions(P['delivery.manage'])
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryActionDto,
  ) {
    return this.deliveries.transition(user.companyId!, user, id, 'cancel', body);
  }

  @Post(':id/invoice')
  @RequirePermissions(P['invoice.create'])
  @ApiOperation({ summary: 'Raise a draft invoice for the delivered, not yet invoiced quantities' })
  invoice(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.invoice(user.companyId!, user, id);
  }
}

// ------------------------------------------------------ credit / debit notes

@ApiTags('Credit Notes')
@Controller('credit-notes')
@CompanyScoped()
export class CreditNotesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermissions(P['invoice.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDocumentsQueryDto) {
    return this.invoices.list(user.companyId!, { ...query, documentType: 'CREDIT_NOTE' });
  }

  @Post()
  @RequirePermissions(P['invoice.create'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateNoteDto) {
    return this.invoices.create(user.companyId!, user, { ...body, documentType: 'CREDIT_NOTE' });
  }
}

@ApiTags('Debit Notes')
@Controller('debit-notes')
@CompanyScoped()
export class DebitNotesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermissions(P['invoice.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDocumentsQueryDto) {
    return this.invoices.list(user.companyId!, { ...query, documentType: 'DEBIT_NOTE' });
  }

  @Post()
  @RequirePermissions(P['invoice.create'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateNoteDto) {
    return this.invoices.create(user.companyId!, user, { ...body, documentType: 'DEBIT_NOTE' });
  }
}

// ----------------------------------------------------------------- refunds

@ApiTags('Customer Refunds')
@Controller('refunds')
@CompanyScoped()
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @RequirePermissions(P['invoice.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListRefundsQueryDto) {
    return this.refunds.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['invoice.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.refunds.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['customer-refund.create'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateRefundDto) {
    return this.refunds.create(user.companyId!, user, body);
  }

  @Post(':id/submit')
  @RequirePermissions(P['customer-refund.create'])
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.refunds.submit(user.companyId!, user, id);
  }

  @Post(':id/approve')
  @RequirePermissions(P['customer-refund.approve'])
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RefundDecisionDto,
  ) {
    return this.refunds.approve(user.companyId!, user, id, body);
  }

  @Post(':id/reject')
  @RequirePermissions(P['customer-refund.approve'])
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RefundDecisionDto,
  ) {
    return this.refunds.reject(user.companyId!, user, id, body);
  }

  @Post(':id/cancel')
  @RequirePermissions(P['customer-refund.create'])
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RefundDecisionDto,
  ) {
    return this.refunds.cancel(user.companyId!, user, id, body);
  }

  @Post(':id/pay')
  @RequirePermissions(P['customer-refund.pay'])
  @ApiOperation({
    summary: 'Pay an approved refund: creates and posts the REFUND receipt (Dr AR / Cr cash)',
  })
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PayRefundDto,
  ) {
    return this.refunds.pay(user.companyId!, user, id, body);
  }
}

// ------------------------------------------------------------- collections

@ApiTags('Collections')
@Controller('collections')
@CompanyScoped()
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get()
  @RequirePermissions(P['collection.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListCasesQueryDto) {
    return this.collections.listCases(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['collection.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.collections.getCase(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['collection.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCaseDto) {
    return this.collections.createCase(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['collection.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCaseDto,
  ) {
    return this.collections.updateCase(user.companyId!, user, id, body);
  }

  @Post(':id/activities')
  @RequirePermissions(P['collection.manage'])
  @ApiOperation({ summary: 'Record a contact, note or escalation on the case' })
  activity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ActivityDto,
  ) {
    return this.collections.addActivity(user.companyId!, user, id, body);
  }

  @Post(':id/credit-hold')
  @RequirePermissions(P['customer.credit-manage'])
  creditHold(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreditHoldDto,
  ) {
    return this.collections.creditHold(user.companyId!, user, id, body);
  }

  @Post('run-sweep')
  @RequirePermissions(P['collection.manage'])
  @ApiOperation({
    summary: 'Run the overdue / dunning / promise sweep now (the scheduler runs it daily)',
  })
  sweep(@CurrentUser() user: AuthenticatedUser, @Body() body: SweepDto) {
    return this.collections.runSweep(user.companyId!, body.asOf ?? today());
  }
}

@ApiTags('Promises To Pay')
@Controller('promises-to-pay')
@CompanyScoped()
export class PromisesController {
  constructor(private readonly collections: CollectionsService) {}

  @Get()
  @RequirePermissions(P['collection.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPromisesQueryDto) {
    return this.collections.listPromises(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['collection.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.collections.getPromise(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['collection.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreatePromiseDto) {
    return this.collections.createPromise(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['collection.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePromiseDto,
  ) {
    return this.collections.updatePromise(user.companyId!, user, id, body);
  }
}

@ApiTags('Disputes')
@Controller('disputes')
@CompanyScoped()
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @RequirePermissions(P['collection.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListDisputesQueryDto) {
    return this.disputes.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['collection.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.disputes.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['dispute.manage'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateDisputeDto) {
    return this.disputes.create(user.companyId!, user, body);
  }

  @Patch(':id')
  @RequirePermissions(P['dispute.manage'])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDisputeDto,
  ) {
    return this.disputes.update(user.companyId!, user, id, body);
  }
}

// -------------------------------------------------------------- write-offs

@ApiTags('Write-Offs')
@Controller('write-offs')
@CompanyScoped()
export class WriteOffsController {
  constructor(private readonly writeOffs: WriteOffsService) {}

  @Get()
  @RequirePermissions(P['write-off.view'])
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListWriteOffsQueryDto) {
    return this.writeOffs.list(user.companyId!, query);
  }

  @Get(':id')
  @RequirePermissions(P['write-off.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.writeOffs.get(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['write-off.create'])
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateWriteOffDto) {
    return this.writeOffs.create(user.companyId!, user, body);
  }

  @Post(':id/submit')
  @RequirePermissions(P['write-off.create'])
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.writeOffs.submit(user.companyId!, user, id);
  }

  @Post(':id/approve')
  @RequirePermissions(P['write-off.approve'])
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: WriteOffDecisionDto,
  ) {
    return this.writeOffs.approve(user.companyId!, user, id, body);
  }

  @Post(':id/reject')
  @RequirePermissions(P['write-off.approve'])
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: WriteOffDecisionDto,
  ) {
    return this.writeOffs.reject(user.companyId!, user, id, body);
  }

  @Post(':id/post')
  @RequirePermissions(P['write-off.post'])
  @ApiOperation({
    summary: 'Post the write-off: Dr allowance / bad debt / write-off account, Cr AR control',
  })
  post(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PostWriteOffDto,
  ) {
    return this.writeOffs.post(user.companyId!, user, id, body.writeOffDate);
  }

  @Post(':id/recover')
  @RequirePermissions(P['write-off.post'])
  @ApiOperation({
    summary: 'Recover a written-off balance: reverses the write-off and reinstates the receivable',
  })
  recover(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecoverWriteOffDto,
  ) {
    return this.writeOffs.recover(user.companyId!, user, id, body);
  }
}

@ApiTags('Bad Debt Provisions')
@Controller('bad-debt-provisions')
@CompanyScoped()
export class ProvisionsController {
  constructor(private readonly writeOffs: WriteOffsService) {}

  @Get()
  @RequirePermissions(P['write-off.view'])
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.writeOffs.listProvisions(user.companyId!);
  }

  @Get(':id')
  @RequirePermissions(P['write-off.view'])
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.writeOffs.getProvision(user.companyId!, id);
  }

  @Post()
  @RequirePermissions(P['write-off.post'])
  @ApiOperation({
    summary:
      'Compute the required allowance (aging rates or specific invoices) and draft the adjustment',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateProvisionDto) {
    return this.writeOffs.createProvision(user.companyId!, user, body);
  }

  @Post(':id/post')
  @RequirePermissions(P['write-off.post'])
  post(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.writeOffs.postProvision(user.companyId!, user, id);
  }

  @Post(':id/reverse')
  @RequirePermissions(P['write-off.post'])
  reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReverseProvisionDto,
  ) {
    return this.writeOffs.reverseProvision(
      user.companyId!,
      user,
      id,
      body.reversalDate,
      body.reason,
    );
  }
}

// ----------------------------------------------------------------- reports

@ApiTags('Receivables Reports')
@Controller()
@CompanyScoped()
export class ArPlatformReportsController {
  constructor(
    private readonly reports: ArReportsService,
    private readonly dashboard: ArDashboardService,
    private readonly integrity: ArIntegrityService,
  ) {}

  @Get('ar-dashboard')
  @RequirePermissions(P['reports.view'])
  @ApiOperation({
    summary:
      'Executive AR dashboard: receivables, aging, DSO, collection rate, unapplied cash, credit exposure, trends',
  })
  getDashboard(@CurrentUser() user: AuthenticatedUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.dashboard(user.companyId!, query.asOf ?? today());
  }

  @Get('ar-aging')
  @RequirePermissions(P['reports.view'])
  aging(@CurrentUser() user: AuthenticatedUser, @Query() query: AgingQueryDto) {
    return this.reports.aging(user.companyId!, query);
  }

  @Get('ar-reconciliation')
  @RequirePermissions(P['reports.view'])
  @ApiOperation({ summary: 'AR subledger vs GL control account, with the AR integrity findings' })
  async reconciliation(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ReconciliationQueryDto,
  ) {
    const [reconciliation, integrity] = await Promise.all([
      this.reports.reconciliation(user.companyId!, query),
      this.integrity.run(user.companyId!, query.asOf),
    ]);
    return { ...reconciliation, integrity };
  }

  @Get('ar-integrity')
  @RequirePermissions(P['reports.view'])
  integrityRun(@CurrentUser() user: AuthenticatedUser, @Query() query: ReconciliationQueryDto) {
    return this.integrity.run(user.companyId!, query.asOf);
  }

  @Get('unapplied-cash')
  @RequirePermissions(P['invoice.view'])
  unapplied(@CurrentUser() user: AuthenticatedUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.unappliedCash(user.companyId!, query.asOf ?? today());
  }

  @Get('customer-statements')
  @RequirePermissions(P['customer.view'])
  @ApiOperation({
    summary:
      'Generate a customer statement for a date range (save=true stores the issued snapshot)',
  })
  statement(@CurrentUser() user: AuthenticatedUser, @Query() query: StatementsQueryDto) {
    return this.dashboard.statement(user.companyId!, user, query);
  }

  @Get('customer-statements/history')
  @RequirePermissions(P['customer.view'])
  statements(@CurrentUser() user: AuthenticatedUser, @Query() query: ListStatementsQueryDto) {
    return this.dashboard.listStatements(user.companyId!, query);
  }

  @Get('customer-statements/history/:id')
  @RequirePermissions(P['customer.view'])
  statementSnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.dashboard.getStatement(user.companyId!, id);
  }
}
