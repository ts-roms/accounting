import { Inject, Injectable } from '@nestjs/common';
import { eq, ne } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/database/database.types';
import { invoices, vendorBills } from '@/database/schema';
import { BillsService } from '@/modules/payables/bills.service';
import { InvoicesService } from '@/modules/receivables/invoices.service';
import { assertScope } from '../importers/importer';
import type { ExportContext, ExportPage, ExportQuery, Exporter } from './exporter';
import { selectKeyset } from './keyset';

/**
 * Document exporters push what the ledger knows: only documents that have
 * left UNPOSTED (POSTED, or REVERSED after a void) are exported, with their
 * lines, tax and allocations exactly as the API returns them. Drafts are
 * never sent anywhere - a provider (e-invoicing authority, CRM, portal) must
 * only ever see figures that exist in the books.
 */
@Injectable()
export class InvoicesExporter implements Exporter {
  readonly entity = 'invoices' as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly invoices: InvoicesService,
  ) {}

  async select(ctx: ExportContext, query: ExportQuery): Promise<ExportPage> {
    assertScope(ctx, 'invoice.view');
    const { ids, hasMore } = await selectKeyset(
      this.db,
      invoices,
      { id: invoices.id, updatedAt: invoices.updatedAt },
      [eq(invoices.companyId, ctx.companyId), ne(invoices.accountingStatus, 'UNPOSTED')],
      query.after,
      query.limit,
    );
    const records = [];
    for (const row of ids) {
      const detail = await this.invoices.get(ctx.companyId, row.id);
      records.push({
        internalId: row.id,
        updatedAt: row.updatedAt,
        label: detail.documentNumber,
        data: { ...detail } as Record<string, unknown>,
      });
    }
    return { records, hasMore };
  }
}

@Injectable()
export class BillsExporter implements Exporter {
  readonly entity = 'bills' as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly bills: BillsService,
  ) {}

  async select(ctx: ExportContext, query: ExportQuery): Promise<ExportPage> {
    assertScope(ctx, 'bill.view');
    const { ids, hasMore } = await selectKeyset(
      this.db,
      vendorBills,
      { id: vendorBills.id, updatedAt: vendorBills.updatedAt },
      [eq(vendorBills.companyId, ctx.companyId), ne(vendorBills.accountingStatus, 'UNPOSTED')],
      query.after,
      query.limit,
    );
    const records = [];
    for (const row of ids) {
      const detail = await this.bills.get(ctx.companyId, row.id);
      records.push({
        internalId: row.id,
        updatedAt: row.updatedAt,
        label: detail.documentNumber,
        data: { ...detail } as Record<string, unknown>,
      });
    }
    return { records, hasMore };
  }
}
