import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { OPEN_DOCUMENT_STATUSES, P, type PaginatedResult } from '@accounting/types';
import type {
  CreateVendorInput,
  ListVendorsQuery,
  UpdateVendorInput,
  VendorAddressInput,
  VendorApprovalInput,
  VendorBankAccountInput,
  VendorContactInput,
  VendorHoldInput,
  VendorProfileInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { AuditService } from '@/modules/audit/audit.service';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { shallowDiff } from '@/common/utils/diff';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  companies,
  paymentTerms,
  taxCodes,
  users,
  vendorAddresses,
  vendorBankAccounts,
  vendorContacts,
  vendorGroups,
  vendorPayments,
  vendorProfiles,
  vendors,
  vendorBills,
  type Vendor,
  type VendorAddress,
  type VendorBankAccount,
  type VendorContact,
  type VendorProfile,
} from '@/database/schema';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { ApConfigService } from './ap-config.service';
import { maskAccountNumber } from './payables.logic';

const MODULE = 'PAYABLES';

export interface VendorBalance {
  /** Open bills/debit notes not yet settled. */
  outstanding: string;
  /** Portion of `outstanding` past its due date (as of today). */
  overdue: string;
  /** Unapplied credit notes plus unallocated payments (net of refunds). */
  unappliedCredit: string;
  /** outstanding - unappliedCredit */
  net: string;
  /** Open bills carrying an active payment hold. */
  onHold: string;
}

export interface VendorView extends Vendor {
  balance: VendorBalance;
  vendorGroupName: string | null;
  paymentTermName: string | null;
  withholdingTaxCode: string | null;
  buyerName: string | null;
  riskRating: VendorProfile['riskRating'];
  onHold: boolean;
}

/** Bank accounts are exposed masked; the full number never leaves the service except for remittance files. */
export type VendorBankAccountView = Omit<VendorBankAccount, 'accountNumber'> & {
  accountNumberMasked: string;
};

export interface VendorDetail extends VendorView {
  contacts: VendorContact[];
  addresses: VendorAddress[];
  bankAccounts: VendorBankAccountView[];
  profile: VendorProfile | null;
}

/**
 * Vendor master (Prompt #7). Balances are never stored: they are derived from
 * posted bills and payments every time. Approval and holds live on
 * `vendors.vendorStatus`; only APPROVED vendors can be ordered from, billed
 * or paid (`assertUsable`).
 */
@Injectable()
export class VendorsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly authority: AuthorityService,
    private readonly config: ApConfigService,
  ) {}

  async list(companyId: string, query: ListVendorsQuery): Promise<PaginatedResult<VendorView>> {
    const filters: SQL[] = [eq(vendors.companyId, companyId)];
    if (query.status) filters.push(eq(vendors.status, query.status));
    if (query.vendorStatus) filters.push(eq(vendors.vendorStatus, query.vendorStatus));
    if (query.vendorGroupId) filters.push(eq(vendors.vendorGroupId, query.vendorGroupId));
    if (query.vendorType) filters.push(eq(vendors.vendorType, query.vendorType));
    if (query.onHold !== undefined)
      filters.push(
        query.onHold
          ? inArray(vendors.vendorStatus, ['ON_HOLD', 'BLOCKED'])
          : inArray(vendors.vendorStatus, ['APPROVED', 'PENDING', 'INACTIVE']),
      );
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(vendors.code, term),
          ilike(vendors.name, term),
          ilike(vendors.email, term),
          ilike(vendors.displayName, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'code'
        ? vendors.code
        : query.sortBy === 'createdAt'
          ? vendors.createdAt
          : vendors.name;
    const [rows, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(query.sortDir === 'desc' ? desc(sortColumn) : asc(sortColumn))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, vendors, where),
    ]);
    const balances = await this.balances(
      companyId,
      rows.map((r) => r.vendor.id),
    );
    return toPaginatedResult(
      rows.map((r) => this.decorate(r, balances.get(r.vendor.id)!)),
      total,
      query,
    );
  }

  async getOrThrow(companyId: string, id: string, executor: DbExecutor = this.db): Promise<Vendor> {
    const [row] = await executor
      .select()
      .from(vendors)
      .where(and(eq(vendors.id, id), eq(vendors.companyId, companyId)));
    if (!row) throw new NotFoundError('Vendor', id);
    return row;
  }

  async getView(companyId: string, id: string): Promise<VendorDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(vendors.id, id), eq(vendors.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Vendor', id);
    const [balances, contacts, addresses, banks, profile] = await Promise.all([
      this.balances(companyId, [id]),
      this.db
        .select()
        .from(vendorContacts)
        .where(eq(vendorContacts.vendorId, id))
        .orderBy(desc(vendorContacts.isPrimary), asc(vendorContacts.name)),
      this.db
        .select()
        .from(vendorAddresses)
        .where(eq(vendorAddresses.vendorId, id))
        .orderBy(asc(vendorAddresses.addressType), desc(vendorAddresses.isDefault)),
      this.db
        .select()
        .from(vendorBankAccounts)
        .where(eq(vendorBankAccounts.vendorId, id))
        .orderBy(desc(vendorBankAccounts.isPrimary), asc(vendorBankAccounts.bankName)),
      this.profile(id),
    ]);
    return {
      ...this.decorate(row, balances.get(id)!),
      contacts,
      addresses,
      bankAccounts: banks.map(maskBank),
      profile,
    };
  }

  /**
   * Vendor usable for new purchase orders, bills and payments: ACTIVE and
   * APPROVED (or PENDING when the company does not require vendor approval).
   */
  async assertUsable(
    companyId: string,
    id: string,
    tx: DbExecutor,
    purpose: 'purchase order' | 'bill' | 'payment' = 'bill',
  ): Promise<Vendor> {
    const vendor = await this.getOrThrow(companyId, id, tx);
    if (vendor.vendorStatus === 'ON_HOLD' || vendor.vendorStatus === 'BLOCKED') {
      const profile = await this.profile(id, tx);
      throw new BusinessRuleError(
        ErrorCodes.VENDOR_ON_HOLD,
        `${vendor.name} is ${vendor.vendorStatus === 'BLOCKED' ? 'blocked' : 'on hold'}; no new ${purpose} can be recorded${profile?.holdReason ? ` (${profile.holdReason.toLowerCase().replace('_', ' ')})` : ''}.`,
        { vendorId: id, vendorStatus: vendor.vendorStatus, reason: profile?.holdReason ?? null },
      );
    }
    if (vendor.vendorStatus === 'PENDING') {
      const settings = await this.config.settings(companyId, tx);
      if (settings.requireVendorApproval)
        throw new BusinessRuleError(
          ErrorCodes.VENDOR_NOT_APPROVED,
          `${vendor.name} has not been approved yet; no new ${purpose} can be recorded.`,
          { vendorId: id, vendorStatus: vendor.vendorStatus },
        );
    }
    if (vendor.vendorStatus === 'INACTIVE' || vendor.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.VENDOR_NOT_APPROVED,
        `${vendor.name} is inactive; no new ${purpose} can be recorded.`,
        { vendorId: id },
      );
    return vendor;
  }

  async create(
    companyId: string,
    input: CreateVendorInput,
    actor?: { id: string; email: string },
  ): Promise<VendorDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.defaultExpenseAccountId)
        await this.accounts.getOrThrow(companyId, input.defaultExpenseAccountId, tx);
      const group = input.vendorGroupId
        ? await this.config.vendorGroup(companyId, input.vendorGroupId, tx)
        : null;
      const settings = await this.config.settings(companyId, tx);
      // Group and company defaults fill what the caller left out; explicit net days win over a default term.
      const paymentTermId =
        input.paymentTermId ??
        (input.paymentTermsDays === undefined
          ? (group?.defaultPaymentTermId ?? settings.defaultPaymentTermId ?? null)
          : null);
      const term = paymentTermId
        ? await this.config.paymentTerm(companyId, paymentTermId, tx)
        : null;
      const paymentTermsDays =
        input.paymentTermsDays ?? (term && term.basis === 'NET_DAYS' ? term.days : 30);
      const defaultWithholdingTaxCodeId =
        input.defaultWithholdingTaxCodeId ?? group?.defaultWithholdingTaxCodeId ?? null;
      if (defaultWithholdingTaxCodeId)
        await this.assertTaxCode(companyId, defaultWithholdingTaxCodeId, tx);
      if (input.buyerId) await this.assertUser(tx, input.buyerId);
      let created: Vendor | undefined;
      try {
        [created] = await tx
          .insert(vendors)
          .values({
            companyId,
            ...nullify(input),
            currency: input.currency ?? (await this.accounts.companyCurrency(companyId, tx)),
            paymentTermId,
            paymentTermsDays,
            vendorGroupId: group?.id ?? null,
            defaultWithholdingTaxCodeId,
            defaultExpenseAccountId:
              input.defaultExpenseAccountId ?? group?.defaultExpenseAccountId ?? null,
            vendorStatus: settings.requireVendorApproval ? 'PENDING' : 'APPROVED',
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'vendors_company_code_uq'))
          throw new DuplicateError('Vendor', 'code', input.code);
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');
      await tx
        .insert(vendorProfiles)
        .values({ vendorId: created.id, requireBillApproval: group?.requireBillApproval ?? false })
        .onConflictDoNothing();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Vendor',
          entityId: created.id,
          newValue: created,
          metadata: actor ? { editor: actor.email } : undefined,
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'vendor.created',
        companyId,
        dedupeKey: 'vendor.created:' + created.id,
        payload: {
          vendorId: created.id,
          code: created.code,
          name: created.name,
          vendorType: created.vendorType,
          vendorStatus: created.vendorStatus,
          currency: created.currency,
        },
      });
      if (created.vendorStatus === 'PENDING' && actor) {
        const [company] = await tx
          .select({ organizationId: companies.organizationId })
          .from(companies)
          .where(eq(companies.id, companyId));
        await this.notifications.notify(
          {
            organizationId: company!.organizationId,
            eventType: 'VENDOR_APPROVAL_REQUIRED',
            severity: 'INFO',
            title: `New vendor ${created.name} awaits approval`,
            body: `Created by ${actor.email}.`,
            link: `/purchasing/vendors/${created.id}`,
            entityType: 'Vendor',
            entityId: created.id,
            permission: 'vendor.approve',
            companyId,
            dedupeKey: `vendor-approval:${created.id}`,
          },
          tx,
        );
      }
      return created.id;
    });
    return this.getView(companyId, id);
  }

  async update(
    companyId: string,
    id: string,
    input: UpdateVendorInput,
    actor?: { id: string; email: string },
  ): Promise<VendorDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(companyId, id, tx);
      if (input.defaultExpenseAccountId)
        await this.accounts.getOrThrow(companyId, input.defaultExpenseAccountId, tx);
      if (input.vendorGroupId) await this.config.vendorGroup(companyId, input.vendorGroupId, tx);
      if (input.paymentTermId) await this.config.paymentTerm(companyId, input.paymentTermId, tx);
      if (input.defaultWithholdingTaxCodeId)
        await this.assertTaxCode(companyId, input.defaultWithholdingTaxCodeId, tx);
      if (input.buyerId) await this.assertUser(tx, input.buyerId);
      let updated: Vendor | undefined;
      try {
        [updated] = await tx
          .update(vendors)
          .set(definedOnly(input))
          .where(eq(vendors.id, id))
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'vendors_company_code_uq'))
          throw new DuplicateError('Vendor', 'code', input.code ?? '');
        throw err;
      }
      if (!updated) throw new Error('Update returned no row');
      const { previous, next } = shallowDiff(existing, updated);
      await this.audit.record(
        {
          action:
            input.status && input.status !== existing.status
              ? input.status === 'ACTIVE'
                ? 'ACTIVATE'
                : 'DEACTIVATE'
              : 'UPDATE',
          module: MODULE,
          entityType: 'Vendor',
          entityId: id,
          previousValue: previous,
          newValue: next,
          metadata: actor ? { editor: actor.email } : undefined,
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'vendor.updated',
        companyId,
        dedupeKey: `vendor.updated:${id}:${updated.updatedAt.toISOString()}`,
        payload: { vendorId: id, code: updated.code, name: updated.name, changes: next },
      });
    });
    return this.getView(companyId, id);
  }

  // ------------------------------------------------------- approval and holds

  /** Vendor onboarding decision; delegable `vendor.approve`. */
  async decide(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: VendorApprovalInput,
  ): Promise<VendorDetail> {
    await this.db.transaction(async (tx) => {
      const vendor = await this.getOrThrow(companyId, id, tx);
      await this.authority.assert(tx, actor, P['vendor.approve'], {
        companyId,
        branchId: vendor.branchId,
        amount: '0',
        currency: vendor.currency,
        documentType: 'VENDOR',
        documentId: id,
        documentNumber: vendor.code,
        createdBy: null,
        action: `Vendor ${input.decision.toLowerCase()}`,
      });
      const status =
        input.decision === 'APPROVE'
          ? 'APPROVED'
          : input.decision === 'BLOCK'
            ? 'BLOCKED'
            : 'INACTIVE';
      await tx.update(vendors).set({ vendorStatus: status }).where(eq(vendors.id, id));
      await tx
        .insert(vendorProfiles)
        .values({
          vendorId: id,
          approvedBy: status === 'APPROVED' ? actor.id : null,
          approvedAt: status === 'APPROVED' ? new Date() : null,
          notes: input.note ?? null,
        })
        .onConflictDoUpdate({
          target: vendorProfiles.vendorId,
          set: {
            approvedBy: status === 'APPROVED' ? actor.id : null,
            approvedAt: status === 'APPROVED' ? new Date() : null,
            holdReason: status === 'BLOCKED' ? 'COMPLIANCE' : null,
            holdNote: status === 'BLOCKED' ? (input.note ?? null) : null,
            holdBy: status === 'BLOCKED' ? actor.id : null,
            holdAt: status === 'BLOCKED' ? new Date() : null,
          },
        });
      await this.audit.record(
        {
          action: input.decision === 'APPROVE' ? 'APPROVE' : 'REJECT',
          module: MODULE,
          entityType: 'Vendor',
          entityId: id,
          previousValue: { vendorStatus: vendor.vendorStatus },
          newValue: { vendorStatus: status, note: input.note ?? null },
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: status === 'APPROVED' ? 'vendor.approved' : 'vendor.on_hold',
        companyId,
        dedupeKey: `vendor.decision:${id}:${status}:${Date.now()}`,
        payload: { vendorId: id, code: vendor.code, name: vendor.name, vendorStatus: status },
      });
    });
    return this.getView(companyId, id);
  }

  /** Place or lift a vendor hold. A hold blocks new purchase orders, bills and payments. */
  async setHold(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: VendorHoldInput,
  ): Promise<VendorDetail> {
    await this.db.transaction(async (tx) => {
      const vendor = await this.getOrThrow(companyId, id, tx);
      if (vendor.vendorStatus === 'BLOCKED' && input.hold === false)
        throw new BusinessRuleError(
          ErrorCodes.VENDOR_ON_HOLD,
          `${vendor.name} is blocked; approve it again to lift the block.`,
        );
      const status = input.hold ? 'ON_HOLD' : 'APPROVED';
      await tx.update(vendors).set({ vendorStatus: status }).where(eq(vendors.id, id));
      await tx.insert(vendorProfiles).values({ vendorId: id }).onConflictDoNothing();
      await tx
        .update(vendorProfiles)
        .set({
          holdReason: input.hold ? (input.reason ?? 'OTHER') : null,
          holdNote: input.hold ? (input.note ?? null) : null,
          holdBy: input.hold ? actor.id : null,
          holdAt: input.hold ? new Date() : null,
        })
        .where(eq(vendorProfiles.vendorId, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Vendor',
          entityId: id,
          previousValue: { vendorStatus: vendor.vendorStatus },
          newValue: {
            vendorStatus: status,
            reason: input.reason ?? null,
            note: input.note ?? null,
          },
          metadata: { editor: actor.email, reason: input.note ?? input.reason ?? null },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: input.hold ? 'vendor.on_hold' : 'vendor.released',
        companyId,
        dedupeKey: `vendor.hold:${id}:${status}:${Date.now()}`,
        payload: {
          vendorId: id,
          code: vendor.code,
          name: vendor.name,
          reason: input.reason ?? null,
        },
      });
      if (input.hold)
        await this.notifications.notify(
          {
            organizationId: actor.organizationId,
            eventType: 'VENDOR_ON_HOLD',
            severity: 'WARNING',
            title: `${vendor.name} placed on hold`,
            body:
              input.note ?? `Reason: ${(input.reason ?? 'OTHER').toLowerCase().replace('_', ' ')}.`,
            link: `/purchasing/vendors/${id}`,
            entityType: 'Vendor',
            entityId: id,
            permission: 'vendor.approve',
            companyId,
            dedupeKey: `vendor-hold:${id}`,
          },
          tx,
        );
    });
    return this.getView(companyId, id);
  }

  async updateProfile(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: VendorProfileInput,
  ): Promise<VendorProfile> {
    return this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      await tx.insert(vendorProfiles).values({ vendorId: id }).onConflictDoNothing();
      const existing = (await this.profile(id, tx))!;
      const [row] = await tx
        .update(vendorProfiles)
        .set(definedOnly(input))
        .where(eq(vendorProfiles.vendorId, id))
        .returning();
      const { previous, next } = shallowDiff(existing, row!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorProfile',
          entityId: id,
          previousValue: previous,
          newValue: next,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async profile(id: string, executor: DbExecutor = this.db): Promise<VendorProfile | null> {
    const [row] = await executor
      .select()
      .from(vendorProfiles)
      .where(eq(vendorProfiles.vendorId, id));
    return row ?? null;
  }

  // ------------------------------------------------------------------ contacts

  async addContact(
    companyId: string,
    id: string,
    input: VendorContactInput,
  ): Promise<VendorContact> {
    return this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      if (input.isPrimary)
        await tx
          .update(vendorContacts)
          .set({ isPrimary: false })
          .where(eq(vendorContacts.vendorId, id));
      const [row] = await tx
        .insert(vendorContacts)
        .values({ vendorId: id, ...nullify(input) })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'VendorContact',
          entityId: row!.id,
          newValue: row,
          metadata: { vendorId: id },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async updateContact(
    companyId: string,
    id: string,
    contactId: string,
    input: Partial<VendorContactInput>,
  ): Promise<VendorContact> {
    return this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      if (input.isPrimary)
        await tx
          .update(vendorContacts)
          .set({ isPrimary: false })
          .where(eq(vendorContacts.vendorId, id));
      const [row] = await tx
        .update(vendorContacts)
        .set(definedOnly(input))
        .where(and(eq(vendorContacts.id, contactId), eq(vendorContacts.vendorId, id)))
        .returning();
      if (!row) throw new NotFoundError('Contact', contactId);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorContact',
          entityId: contactId,
          newValue: input,
          metadata: { vendorId: id },
          companyId,
        },
        tx,
      );
      return row;
    });
  }

  async removeContact(companyId: string, id: string, contactId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      const deleted = await tx
        .delete(vendorContacts)
        .where(and(eq(vendorContacts.id, contactId), eq(vendorContacts.vendorId, id)))
        .returning({ id: vendorContacts.id });
      if (!deleted.length) throw new NotFoundError('Contact', contactId);
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'VendorContact',
          entityId: contactId,
          metadata: { vendorId: id },
          companyId,
        },
        tx,
      );
    });
  }

  // ----------------------------------------------------------------- addresses

  async addAddress(
    companyId: string,
    id: string,
    input: VendorAddressInput,
  ): Promise<VendorAddress> {
    return this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      if (input.isDefault)
        await tx
          .update(vendorAddresses)
          .set({ isDefault: false })
          .where(
            and(
              eq(vendorAddresses.vendorId, id),
              eq(vendorAddresses.addressType, input.addressType),
            ),
          );
      const [row] = await tx
        .insert(vendorAddresses)
        .values({ vendorId: id, ...nullify(input) })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'VendorAddress',
          entityId: row!.id,
          newValue: row,
          metadata: { vendorId: id },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async updateAddress(
    companyId: string,
    id: string,
    addressId: string,
    input: Partial<VendorAddressInput>,
  ): Promise<VendorAddress> {
    return this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      const [current] = await tx
        .select()
        .from(vendorAddresses)
        .where(and(eq(vendorAddresses.id, addressId), eq(vendorAddresses.vendorId, id)));
      if (!current) throw new NotFoundError('Address', addressId);
      if (input.isDefault)
        await tx
          .update(vendorAddresses)
          .set({ isDefault: false })
          .where(
            and(
              eq(vendorAddresses.vendorId, id),
              eq(vendorAddresses.addressType, input.addressType ?? current.addressType),
            ),
          );
      const [row] = await tx
        .update(vendorAddresses)
        .set(definedOnly(input))
        .where(eq(vendorAddresses.id, addressId))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorAddress',
          entityId: addressId,
          newValue: input,
          metadata: { vendorId: id },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async removeAddress(companyId: string, id: string, addressId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      const deleted = await tx
        .delete(vendorAddresses)
        .where(and(eq(vendorAddresses.id, addressId), eq(vendorAddresses.vendorId, id)))
        .returning({ id: vendorAddresses.id });
      if (!deleted.length) throw new NotFoundError('Address', addressId);
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'VendorAddress',
          entityId: addressId,
          metadata: { vendorId: id },
          companyId,
        },
        tx,
      );
    });
  }

  // ------------------------------------------------------------- bank accounts

  async addBankAccount(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: VendorBankAccountInput,
  ): Promise<VendorBankAccountView> {
    return this.db.transaction(async (tx) => {
      const vendor = await this.getOrThrow(companyId, id, tx);
      if (input.isPrimary)
        await tx
          .update(vendorBankAccounts)
          .set({ isPrimary: false })
          .where(eq(vendorBankAccounts.vendorId, id));
      const [row] = await tx
        .insert(vendorBankAccounts)
        .values({
          vendorId: id,
          ...nullify(input),
          currency: input.currency ?? vendor.currency,
        })
        .returning();
      // The audit trail carries the masked number only.
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'VendorBankAccount',
          entityId: row!.id,
          newValue: maskBank(row!),
          metadata: { vendorId: id, editor: actor.email },
          companyId,
        },
        tx,
      );
      return maskBank(row!);
    });
  }

  async updateBankAccount(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    bankId: string,
    input: Partial<VendorBankAccountInput> & { status?: 'ACTIVE' | 'INACTIVE'; verified?: boolean },
  ): Promise<VendorBankAccountView> {
    return this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      if (input.isPrimary)
        await tx
          .update(vendorBankAccounts)
          .set({ isPrimary: false })
          .where(eq(vendorBankAccounts.vendorId, id));
      const { verified, ...rest } = input;
      const [row] = await tx
        .update(vendorBankAccounts)
        .set({
          ...definedOnly(rest),
          ...(verified === undefined
            ? {}
            : { verifiedBy: verified ? actor.id : null, verifiedAt: verified ? new Date() : null }),
        })
        .where(and(eq(vendorBankAccounts.id, bankId), eq(vendorBankAccounts.vendorId, id)))
        .returning();
      if (!row) throw new NotFoundError('Bank account', bankId);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorBankAccount',
          entityId: bankId,
          newValue: {
            ...definedOnly(rest),
            accountNumber: rest.accountNumber ? maskAccountNumber(rest.accountNumber) : undefined,
            verified,
          },
          metadata: { vendorId: id, editor: actor.email },
          companyId,
        },
        tx,
      );
      return maskBank(row);
    });
  }

  async removeBankAccount(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    bankId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      const deleted = await tx
        .delete(vendorBankAccounts)
        .where(and(eq(vendorBankAccounts.id, bankId), eq(vendorBankAccounts.vendorId, id)))
        .returning({ id: vendorBankAccounts.id });
      if (!deleted.length) throw new NotFoundError('Bank account', bankId);
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'VendorBankAccount',
          entityId: bankId,
          metadata: { vendorId: id, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
  }

  /** Primary (or first active) bank account with the full number - remittance files only. */
  async remittanceBankAccount(
    vendorId: string,
    executor: DbExecutor = this.db,
  ): Promise<VendorBankAccount | null> {
    const [row] = await executor
      .select()
      .from(vendorBankAccounts)
      .where(
        and(eq(vendorBankAccounts.vendorId, vendorId), eq(vendorBankAccounts.status, 'ACTIVE')),
      )
      .orderBy(desc(vendorBankAccounts.isPrimary), asc(vendorBankAccounts.createdAt))
      .limit(1);
    return row ?? null;
  }

  // ------------------------------------------------------------------ balances

  /** Open balances per vendor from the subledger documents. */
  async balances(
    companyId: string,
    vendorIds: string[],
    executor: DbExecutor = this.db,
  ): Promise<Map<string, VendorBalance>> {
    const result = new Map<string, VendorBalance>();
    if (vendorIds.length === 0) return result;
    const currency = await this.accounts.companyCurrency(companyId, executor);
    const today = new Date().toISOString().slice(0, 10);
    for (const id of vendorIds)
      result.set(id, {
        outstanding: '0.0000',
        overdue: '0.0000',
        unappliedCredit: '0.0000',
        net: '0.0000',
        onHold: '0.0000',
      });

    const openDocs = await executor
      .select({
        vendorId: vendorBills.vendorId,
        documentType: vendorBills.documentType,
        outstanding: sql<string>`coalesce(sum(${vendorBills.total} - ${vendorBills.allocatedAmount}), 0)`,
        overdue: sql<string>`coalesce(sum(case when ${vendorBills.dueDate} < ${today} then ${vendorBills.total} - ${vendorBills.allocatedAmount} else 0 end), 0)`,
        onHold: sql<string>`coalesce(sum(case when ${vendorBills.onHold} then ${vendorBills.total} - ${vendorBills.allocatedAmount} else 0 end), 0)`,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          inArray(vendorBills.vendorId, vendorIds),
          eq(vendorBills.accountingStatus, 'POSTED'),
          inArray(vendorBills.status, [...OPEN_DOCUMENT_STATUSES]),
        ),
      )
      .groupBy(vendorBills.vendorId, vendorBills.documentType);

    const payments = await executor
      .select({
        vendorId: vendorPayments.vendorId,
        paymentType: vendorPayments.paymentType,
        unallocated: sql<string>`coalesce(sum(${vendorPayments.amount} - ${vendorPayments.allocatedAmount}), 0)`,
      })
      .from(vendorPayments)
      .where(
        and(
          eq(vendorPayments.companyId, companyId),
          inArray(vendorPayments.vendorId, vendorIds),
          eq(vendorPayments.status, 'POSTED'),
        ),
      )
      .groupBy(vendorPayments.vendorId, vendorPayments.paymentType);

    const acc = new Map<
      string,
      { outstanding: Money; overdue: Money; credit: Money; onHold: Money }
    >();
    const get = (id: string) =>
      acc.get(id) ?? {
        outstanding: Money.zero(currency),
        overdue: Money.zero(currency),
        credit: Money.zero(currency),
        onHold: Money.zero(currency),
      };
    for (const row of openDocs) {
      const a = get(row.vendorId);
      if (row.documentType === 'CREDIT_NOTE')
        a.credit = a.credit.add(Money.of(row.outstanding, currency));
      else {
        a.outstanding = a.outstanding.add(Money.of(row.outstanding, currency));
        a.overdue = a.overdue.add(Money.of(row.overdue, currency));
        a.onHold = a.onHold.add(Money.of(row.onHold, currency));
      }
      acc.set(row.vendorId, a);
    }
    for (const row of payments) {
      const a = get(row.vendorId);
      const amount = Money.of(row.unallocated, currency);
      a.credit = row.paymentType === 'PAYMENT' ? a.credit.add(amount) : a.credit.subtract(amount);
      acc.set(row.vendorId, a);
    }
    for (const [id, a] of acc) {
      result.set(id, {
        outstanding: a.outstanding.toString(),
        overdue: a.overdue.toString(),
        unappliedCredit: a.credit.toString(),
        net: a.outstanding.subtract(a.credit).toString(),
        onHold: a.onHold.toString(),
      });
    }
    return result;
  }

  // ----------------------------------------------------------------- internals

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        vendor: vendors,
        vendorGroupName: vendorGroups.name,
        paymentTermName: paymentTerms.name,
        withholdingTaxCode: taxCodes.code,
        buyerName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
        riskRating: sql<VendorProfile['riskRating']>`coalesce(${vendorProfiles.riskRating}, 'LOW')`,
      })
      .from(vendors)
      .leftJoin(vendorGroups, eq(vendorGroups.id, vendors.vendorGroupId))
      .leftJoin(paymentTerms, eq(paymentTerms.id, vendors.paymentTermId))
      .leftJoin(taxCodes, eq(taxCodes.id, vendors.defaultWithholdingTaxCodeId))
      .leftJoin(users, eq(users.id, vendors.buyerId))
      .leftJoin(vendorProfiles, eq(vendorProfiles.vendorId, vendors.id));
  }

  private decorate(
    row: {
      vendor: Vendor;
      vendorGroupName: string | null;
      paymentTermName: string | null;
      withholdingTaxCode: string | null;
      buyerName: string | null;
      riskRating: VendorProfile['riskRating'];
    },
    balance: VendorBalance,
  ): VendorView {
    return {
      ...row.vendor,
      balance,
      vendorGroupName: row.vendorGroupName,
      paymentTermName: row.paymentTermName,
      withholdingTaxCode: row.withholdingTaxCode,
      buyerName: row.buyerName,
      riskRating: row.riskRating,
      onHold: row.vendor.vendorStatus === 'ON_HOLD' || row.vendor.vendorStatus === 'BLOCKED',
    };
  }

  private async assertUser(tx: DbExecutor, userId: string): Promise<void> {
    const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!row) throw new NotFoundError('User', userId);
  }

  private async assertTaxCode(companyId: string, id: string, tx: DbExecutor): Promise<void> {
    const [row] = await tx
      .select({ id: taxCodes.id })
      .from(taxCodes)
      .where(and(eq(taxCodes.id, id), eq(taxCodes.companyId, companyId)));
    if (!row) throw new NotFoundError('Tax code', id);
  }
}

function maskBank(row: VendorBankAccount): VendorBankAccountView {
  const { accountNumber, ...rest } = row;
  return { ...rest, accountNumberMasked: maskAccountNumber(accountNumber) };
}

function nullify<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]: T[K] extends undefined ? null : T[K] } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = v === undefined ? null : v;
  return out as { [K in keyof T]: T[K] extends undefined ? null : T[K] };
}

function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
