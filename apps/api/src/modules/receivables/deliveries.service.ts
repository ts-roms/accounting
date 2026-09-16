import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type DeliveryStatus, type PaginatedResult } from '@accounting/types';
import type {
  CreateDeliveryInput,
  DeliveryActionInput,
  DeliveryLineInput,
  ListDeliveriesQuery,
  UpdateDeliveryInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  customers,
  deliveries,
  deliveryLines,
  invoices,
  journalEntries,
  orderLines,
  orders,
  products,
  type Delivery,
  type DeliveryLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { DocumentStockService } from '@/modules/inventory/document-stock.service';
import { InventoryService } from '@/modules/inventory/inventory.service';
import { OrderFulfillmentService } from '@/modules/orders/order-fulfillment.service';
import { CustomersService } from './customers.service';
import { InvoicesService, type InvoiceDetail } from './invoices.service';

const MODULE = 'RECEIVABLES';

export interface DeliveryView extends Delivery {
  customerCode: string;
  customerName: string;
  salesOrderNumber: string;
  journalNumber: string | null;
  invoiceCount: number;
}

export interface DeliveryLineView extends DeliveryLine {
  productSku: string | null;
  orderedQuantity: string;
  unitPrice: string;
  remainingToInvoice: string;
}

export interface DeliveryDetail extends DeliveryView {
  lines: DeliveryLineView[];
}

const TRANSITIONS: Record<
  'pick' | 'ready' | 'deliver' | 'cancel',
  { from: DeliveryStatus[]; to: DeliveryStatus }
> = {
  pick: { from: ['DRAFT'], to: 'PICKING' },
  ready: { from: ['PICKING', 'DRAFT'], to: 'READY' },
  deliver: { from: ['DRAFT', 'PICKING', 'READY'], to: 'DELIVERED' },
  cancel: { from: ['DRAFT', 'PICKING', 'READY', 'DELIVERED'], to: 'CANCELLED' },
};

/**
 * Deliveries against sales orders (Prompt #6). A delivery never posts revenue:
 * when goods leave (DELIVERED) stocked lines move through InventoryService and
 * the cost of goods is posted in the same transaction through the posting
 * gateway; the invoice that later bills the delivery does not move stock again.
 * Delivered quantities are fulfilment counters on the order lines.
 */
@Injectable()
export class DeliveriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly fulfillment: OrderFulfillmentService,
    private readonly stock: DocumentStockService,
    private readonly inventory: InventoryService,
    private readonly customersService: CustomersService,
    private readonly invoicesService: InvoicesService,
    private readonly outbox: OutboxService,
  ) {}

  async list(
    companyId: string,
    query: ListDeliveriesQuery,
  ): Promise<PaginatedResult<DeliveryView>> {
    const filters: SQL[] = [eq(deliveries.companyId, companyId)];
    if (query.customerId) filters.push(eq(deliveries.customerId, query.customerId));
    if (query.salesOrderId) filters.push(eq(deliveries.salesOrderId, query.salesOrderId));
    if (query.status) filters.push(eq(deliveries.status, query.status));
    if (query.from) filters.push(gte(deliveries.deliveryDate, query.from));
    if (query.to) filters.push(lte(deliveries.deliveryDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(deliveries.documentNumber, term),
          ilike(deliveries.reference, term),
          ilike(customers.name, term),
          ilike(orders.documentNumber, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'documentNumber' ? deliveries.documentNumber : deliveries.deliveryDate;
    const [rows, count] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(
          query.sortDir === 'asc' ? asc(sortColumn) : desc(sortColumn),
          desc(deliveries.documentNumber),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(deliveries)
        .innerJoin(customers, eq(customers.id, deliveries.customerId))
        .innerJoin(orders, eq(orders.id, deliveries.salesOrderId))
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(count[0]?.n ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<DeliveryDetail> {
    const [row] = await this.viewQuery().where(
      and(eq(deliveries.id, id), eq(deliveries.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Delivery', id);
    return { ...row, lines: await this.lines(this.db, id) };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateDeliveryInput,
  ): Promise<DeliveryDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: deliveries.id })
          .from(deliveries)
          .where(
            and(
              eq(deliveries.companyId, companyId),
              eq(deliveries.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const { order, lines: orderRows } = await this.fulfillment.lockOpenOrder(
        tx,
        companyId,
        input.salesOrderId,
        'SALES_ORDER',
      );
      const customer = await this.customersService.getOrThrow(companyId, order.customerId!, tx);
      const byId = new Map(orderRows.map((l) => [l.id, l]));
      // Default: everything still undelivered on the order.
      const requested: DeliveryLineInput[] =
        input.lines ??
        orderRows
          .map((l) => ({
            orderLineId: l.id,
            quantity: this.fulfillment.remaining(l, 'DELIVERY', order.currency, 'SALES_ORDER'),
            warehouseId: l.warehouseId ?? input.warehouseId ?? order.warehouseId ?? null,
          }))
          .filter((l) => Money.of(l.quantity, order.currency).isPositive());
      if (requested.length === 0)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `${order.documentNumber} has nothing left to deliver.`,
        );
      const lines = requested.map((l, i) => {
        const ol = byId.get(l.orderLineId);
        if (!ol) throw new NotFoundError('Order line', l.orderLineId);
        const remaining = this.fulfillment.remaining(ol, 'DELIVERY', order.currency, 'SALES_ORDER');
        if (Money.of(l.quantity, order.currency).greaterThan(Money.of(remaining, order.currency)))
          throw new BusinessRuleError(
            ErrorCodes.ORDER_LINE_OVERFULFILLED,
            `Line ${ol.lineNumber}: only ${remaining} left to deliver.`,
          );
        return {
          lineNumber: i + 1,
          orderLineId: ol.id,
          productId: ol.productId,
          warehouseId:
            l.warehouseId ?? ol.warehouseId ?? input.warehouseId ?? order.warehouseId ?? null,
          description: ol.description,
          quantity: Money.of(l.quantity, order.currency).toString(),
          lotNumber: l.lotNumber ?? null,
          serialNumbers: l.serialNumbers ?? [],
        };
      });
      await this.stock.validateLines(tx, companyId, lines);
      const documentNumber = await this.numbering.allocate(
        companyId,
        'DLV',
        Number(input.deliveryDate.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(deliveries)
        .values({
          companyId,
          branchId: input.branchId ?? order.branchId ?? null,
          documentNumber,
          salesOrderId: order.id,
          customerId: customer.id,
          warehouseId: input.warehouseId ?? order.warehouseId ?? null,
          shippingAddressId: input.shippingAddressId ?? null,
          deliveryDate: input.deliveryDate,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      await tx.insert(deliveryLines).values(lines.map((l) => ({ ...l, deliveryId: created!.id })));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Delivery',
          entityId: created!.id,
          newValue: { documentNumber, salesOrder: order.documentNumber, lines: lines.length },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'delivery.created',
        companyId,
        dedupeKey: 'delivery.created:' + created!.id,
        payload: {
          deliveryId: created!.id,
          documentNumber,
          salesOrderId: order.id,
          customerId: customer.id,
          status: 'DRAFT',
        },
      });
      return created!.id;
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateDeliveryInput,
  ): Promise<DeliveryDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status === 'DELIVERED' || existing.status === 'CANCELLED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      if (input.lines) {
        const { order, lines: orderRows } = await this.fulfillment.lockOpenOrder(
          tx,
          companyId,
          existing.salesOrderId,
          'SALES_ORDER',
        );
        const byId = new Map(orderRows.map((l) => [l.id, l]));
        const lines = input.lines.map((l, i) => {
          const ol = byId.get(l.orderLineId);
          if (!ol) throw new NotFoundError('Order line', l.orderLineId);
          return {
            lineNumber: i + 1,
            orderLineId: ol.id,
            productId: ol.productId,
            warehouseId:
              l.warehouseId ?? ol.warehouseId ?? input.warehouseId ?? existing.warehouseId ?? null,
            description: ol.description,
            quantity: Money.of(l.quantity, order.currency).toString(),
            lotNumber: l.lotNumber ?? null,
            serialNumbers: l.serialNumbers ?? [],
          };
        });
        await this.stock.validateLines(tx, companyId, lines);
        await tx.delete(deliveryLines).where(eq(deliveryLines.deliveryId, id));
        await tx.insert(deliveryLines).values(lines.map((l) => ({ ...l, deliveryId: id })));
      }
      await tx
        .update(deliveries)
        .set({
          deliveryDate: input.deliveryDate ?? existing.deliveryDate,
          warehouseId: input.warehouseId === undefined ? existing.warehouseId : input.warehouseId,
          branchId: input.branchId === undefined ? existing.branchId : input.branchId,
          reference: input.reference === undefined ? existing.reference : input.reference,
          notes: input.notes === undefined ? existing.notes : input.notes,
          shippingAddressId:
            input.shippingAddressId === undefined
              ? existing.shippingAddressId
              : input.shippingAddressId,
        })
        .where(eq(deliveries.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Delivery',
          entityId: id,
          newValue: input,
          metadata: { documentNumber: existing.documentNumber, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `Only draft deliveries can be deleted.`,
        );
      await tx.delete(deliveries).where(eq(deliveries.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Delivery',
          entityId: id,
          previousValue: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
  }

  /** pick / ready / deliver / cancel. Delivering moves stock and posts COGS; cancelling a delivered one reverses both. */
  async transition(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    action: keyof typeof TRANSITIONS,
    input: DeliveryActionInput = {},
  ): Promise<DeliveryDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      const rule = TRANSITIONS[action];
      if (!rule.from.includes(existing.status))
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status} and cannot be ${action === 'deliver' ? 'delivered' : action === 'pick' ? 'picked' : action === 'ready' ? 'marked ready' : 'cancelled'}.`,
        );
      const lines = await tx
        .select()
        .from(deliveryLines)
        .where(eq(deliveryLines.deliveryId, id))
        .orderBy(asc(deliveryLines.lineNumber));
      const patch: Partial<typeof deliveries.$inferInsert> = { status: rule.to };

      if (action === 'deliver') {
        const deliveryDate = input.deliveryDate ?? existing.deliveryDate;
        const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
        await this.fulfillment.consume(
          tx,
          companyId,
          existing.salesOrderId,
          'DELIVERY',
          lines.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity })),
          { expectedType: 'SALES_ORDER', partyId: existing.customerId },
        );
        const stock = await this.stock.postSalesLines(tx, {
          companyId,
          sourceId: id,
          movementDate: deliveryDate,
          actorId: actor.id,
          currency: baseCurrency,
          isCreditNote: false,
          sourceType: 'DELIVERY',
          lines: lines.map((l) => ({
            id: l.id,
            description: l.description,
            quantity: l.quantity,
            amount: '0',
            accountId: '',
            branchId: existing.branchId,
            productId: l.productId,
            warehouseId: l.warehouseId,
            lotNumber: l.lotNumber,
            serialNumbers: l.serialNumbers,
            orderLineId: l.orderLineId,
          })),
        });
        for (const [lineId, cost] of stock.costByLine)
          await tx
            .update(deliveryLines)
            .set({ costAmount: cost.toString() })
            .where(eq(deliveryLines.id, lineId));
        if (stock.postingLines.length > 0) {
          const entry = await this.posting.postEvent(
            tx,
            {
              companyId,
              entryDate: deliveryDate,
              description: `Delivery ${existing.documentNumber} - cost of goods delivered`,
              reference: existing.reference ?? existing.documentNumber,
              journalType: 'GENERAL',
              branchId: existing.branchId,
              sourceType: 'DELIVERY',
              sourceId: id,
              actor,
              lines: stock.postingLines,
            },
            { permission: P['delivery.manage'] },
          );
          await this.inventory.setJournal(tx, stock.movementIds, entry.id);
          patch.journalEntryId = entry.id;
        }
        patch.deliveryDate = deliveryDate;
        patch.deliveredBy = actor.id;
        patch.deliveredAt = new Date();
      }

      if (action === 'cancel') {
        const [invoiced] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(invoices)
          .where(and(eq(invoices.deliveryId, id), sql`${invoices.status} <> 'VOID'`));
        if (Number(invoiced?.n ?? 0) > 0)
          throw new BusinessRuleError(
            ErrorCodes.DOCUMENT_HAS_ALLOCATIONS,
            `${existing.documentNumber} has been invoiced; void the invoice first.`,
          );
        if (existing.status === 'DELIVERED') {
          const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
          const reversalDate = input.deliveryDate ?? new Date().toISOString().slice(0, 10);
          const stockReversal = await this.inventory.reverseDocument(
            tx,
            companyId,
            'DELIVERY',
            id,
            'DELIVERY_CANCEL',
            reversalDate,
            actor.id,
            baseCurrency,
          );
          if (existing.journalEntryId) {
            const originalLines = await tx.query.journalLines.findMany({
              where: (l, ops) => ops.eq(l.journalEntryId, existing.journalEntryId!),
              orderBy: (l, ops) => ops.asc(l.lineNumber),
            });
            const reversal = await this.posting.postEvent(
              tx,
              {
                companyId,
                entryDate: reversalDate,
                description: `Cancel delivery ${existing.documentNumber}: ${input.reason ?? 'cancelled'}`,
                reference: existing.documentNumber,
                journalType: 'REVERSAL',
                branchId: existing.branchId,
                sourceType: 'DELIVERY_CANCEL',
                sourceId: id,
                reversalOfId: existing.journalEntryId,
                actor,
                lines: originalLines.map((l) => ({
                  accountId: l.accountId,
                  debit: l.credit,
                  credit: l.debit,
                  description: l.description,
                  branchId: l.branchId,
                  departmentId: l.departmentId,
                  costCenterId: l.costCenterId,
                  projectId: l.projectId,
                })),
              },
              { permission: P['delivery.manage'] },
            );
            await tx
              .update(journalEntries)
              .set({ status: 'REVERSED', reversedById: reversal.id })
              .where(eq(journalEntries.id, existing.journalEntryId));
            await this.inventory.setJournal(tx, stockReversal.movementIds, reversal.id);
            patch.reversalJournalEntryId = reversal.id;
          }
          await this.fulfillment.release(
            tx,
            existing.salesOrderId,
            'DELIVERY',
            lines.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity })),
          );
        }
        patch.cancelReason = input.reason ?? null;
      }

      await tx.update(deliveries).set(patch).where(eq(deliveries.id, id));
      await this.audit.record(
        {
          action: action === 'deliver' ? 'POST' : action === 'cancel' ? 'VOID' : 'UPDATE',
          module: MODULE,
          entityType: 'Delivery',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: rule.to, reason: input.reason },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
      if (action === 'deliver')
        await this.outbox.enqueue(tx, {
          eventType: 'delivery.delivered',
          companyId,
          dedupeKey: 'delivery.delivered:' + id,
          payload: {
            deliveryId: id,
            documentNumber: existing.documentNumber,
            salesOrderId: existing.salesOrderId,
            customerId: existing.customerId,
            deliveryDate: patch.deliveryDate,
          },
        });
    });
    return this.get(companyId, id);
  }

  /** Raises a draft invoice for the delivered (not yet invoiced) quantities at the order prices. */
  async invoice(companyId: string, actor: AuthenticatedUser, id: string): Promise<InvoiceDetail> {
    const invoiceId = await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DELIVERED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} must be delivered before it is invoiced.`,
        );
      const [order] = await tx.select().from(orders).where(eq(orders.id, existing.salesOrderId));
      if (!order) throw new NotFoundError('Sales order', existing.salesOrderId);
      const lines = await this.lines(tx, id);
      const open = lines.filter((l) => Money.of(l.remainingToInvoice, order.currency).isPositive());
      if (open.length === 0)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is fully invoiced.`,
        );
      const orderRows = await tx.select().from(orderLines).where(eq(orderLines.orderId, order.id));
      const byId = new Map(orderRows.map((l) => [l.id, l]));
      const { id: created } = await this.invoicesService.createInTx(tx, companyId, actor, {
        customerId: existing.customerId,
        documentType: 'INVOICE',
        documentDate: existing.deliveryDate,
        reference: order.reference ?? existing.documentNumber,
        description: `Delivery ${existing.documentNumber} against ${order.documentNumber}`,
        branchId: existing.branchId ?? order.branchId ?? null,
        salesOrderId: order.id,
        deliveryId: id,
        paymentTermId: order.paymentTermId ?? null,
        lines: open.map((l) => {
          const ol = byId.get(l.orderLineId)!;
          return {
            description: l.description,
            quantity: l.remainingToInvoice,
            unitPrice: ol.unitPrice,
            discountPercent: ol.discountPercent,
            accountId: ol.accountId,
            branchId: ol.branchId,
            orderLineId: ol.id,
            productId: ol.productId,
            warehouseId: l.warehouseId ?? ol.warehouseId ?? null,
            serialNumbers: [],
          };
        }),
      });
      return created;
    });
    return this.invoicesService.get(companyId, invoiceId);
  }

  // --------------------------------------------------------------- internals

  private viewQuery() {
    return this.db
      .select({
        id: deliveries.id,
        companyId: deliveries.companyId,
        branchId: deliveries.branchId,
        documentNumber: deliveries.documentNumber,
        salesOrderId: deliveries.salesOrderId,
        customerId: deliveries.customerId,
        warehouseId: deliveries.warehouseId,
        shippingAddressId: deliveries.shippingAddressId,
        status: deliveries.status,
        deliveryDate: deliveries.deliveryDate,
        reference: deliveries.reference,
        notes: deliveries.notes,
        cancelReason: deliveries.cancelReason,
        journalEntryId: deliveries.journalEntryId,
        reversalJournalEntryId: deliveries.reversalJournalEntryId,
        idempotencyKey: deliveries.idempotencyKey,
        deliveredBy: deliveries.deliveredBy,
        deliveredAt: deliveries.deliveredAt,
        createdBy: deliveries.createdBy,
        createdAt: deliveries.createdAt,
        updatedAt: deliveries.updatedAt,
        customerCode: customers.code,
        customerName: customers.name,
        salesOrderNumber: orders.documentNumber,
        journalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${deliveries.journalEntryId})`,
        invoiceCount: sql<number>`(select count(*)::int from invoices i where i.delivery_id = ${deliveries.id} and i.status <> 'VOID')`,
      })
      .from(deliveries)
      .innerJoin(customers, eq(customers.id, deliveries.customerId))
      .innerJoin(orders, eq(orders.id, deliveries.salesOrderId));
  }

  private async lines(executor: DbExecutor, deliveryId: string): Promise<DeliveryLineView[]> {
    const rows = await executor
      .select({
        line: deliveryLines,
        productSku: products.sku,
        orderedQuantity: orderLines.quantity,
        unitPrice: orderLines.unitPrice,
      })
      .from(deliveryLines)
      .innerJoin(orderLines, eq(orderLines.id, deliveryLines.orderLineId))
      .leftJoin(products, eq(products.id, deliveryLines.productId))
      .where(eq(deliveryLines.deliveryId, deliveryId))
      .orderBy(asc(deliveryLines.lineNumber));
    return rows.map((r) => ({
      ...r.line,
      productSku: r.productSku,
      orderedQuantity: r.orderedQuantity,
      unitPrice: r.unitPrice,
      remainingToInvoice: Money.of(r.line.quantity, 'PHP')
        .subtract(Money.of(r.line.invoicedQuantity, 'PHP'))
        .toString(),
    }));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<Delivery> {
    const [row] = await tx
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.id, id), eq(deliveries.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Delivery', id);
    return row;
  }
}
