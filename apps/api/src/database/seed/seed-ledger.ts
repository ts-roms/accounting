import { and, eq, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { DocumentType, JournalType } from '@accounting/types';
import * as schema from '../schema';
import type { Tx } from './seed';

/**
 * Low-level helpers used by the seed to write ledger data the same way the
 * services do: numbered documents, DRAFT-then-POSTED journal entries (the
 * immutability triggers forbid writing lines to a posted entry).
 */

export async function allocateNumber(
  tx: Tx,
  companyId: string,
  documentType: DocumentType,
  isoDate: string,
): Promise<string> {
  const year = Number(isoDate.slice(0, 4));
  const [seq] = await tx
    .insert(schema.documentSequences)
    .values({ companyId, documentType, year, prefix: documentType, nextNumber: 2 })
    .onConflictDoUpdate({
      target: [
        schema.documentSequences.companyId,
        schema.documentSequences.documentType,
        schema.documentSequences.year,
      ],
      set: { nextNumber: sql`${schema.documentSequences.nextNumber} + 1` },
    })
    .returning({
      nextNumber: schema.documentSequences.nextNumber,
      padding: schema.documentSequences.padding,
    });
  return `${documentType}-${year}-${String(seq!.nextNumber - 1).padStart(seq!.padding, '0')}`;
}

export async function periodFor(tx: Tx, companyId: string, isoDate: string): Promise<string> {
  const [period] = await tx
    .select({ id: schema.fiscalPeriods.id })
    .from(schema.fiscalPeriods)
    .where(
      and(
        eq(schema.fiscalPeriods.companyId, companyId),
        sql`${schema.fiscalPeriods.startDate} <= ${isoDate}`,
        sql`${schema.fiscalPeriods.endDate} >= ${isoDate}`,
      ),
    );
  if (!period) throw new Error(`Seed: no fiscal period covers ${isoDate}`);
  return period.id;
}

export interface SeedLine {
  accountId: string;
  debit?: string;
  credit?: string;
  memo?: string | null;
}

export interface SeedEntry {
  date: string;
  description: string;
  reference?: string | null;
  journalType?: JournalType;
  sourceType?: string;
  sourceId?: string;
  status: 'POSTED' | 'SUBMITTED';
  lines: SeedLine[];
}

export async function insertEntry(
  tx: Tx,
  company: schema.Company,
  entry: SeedEntry,
  actorId: string,
): Promise<string> {
  const currency = company.baseCurrency;
  const lines = entry.lines.map((l) => ({
    accountId: l.accountId,
    debit: Money.of(l.debit ?? '0', currency),
    credit: Money.of(l.credit ?? '0', currency),
    memo: l.memo ?? null,
  }));
  const totalDebit = Money.sum(
    lines.map((l) => l.debit),
    currency,
  );
  const totalCredit = Money.sum(
    lines.map((l) => l.credit),
    currency,
  );
  if (!totalDebit.equals(totalCredit))
    throw new Error(`Seed: unbalanced entry "${entry.description}"`);

  const fiscalPeriodId = await periodFor(tx, company.id, entry.date);
  const documentNumber = await allocateNumber(tx, company.id, 'JE', entry.date);
  const [created] = await tx
    .insert(schema.journalEntries)
    .values({
      companyId: company.id,
      fiscalPeriodId,
      documentNumber,
      journalType: entry.journalType ?? 'GENERAL',
      status: 'DRAFT',
      entryDate: entry.date,
      description: entry.description,
      reference: entry.reference ?? null,
      currency,
      totalDebit: totalDebit.toString(),
      totalCredit: totalCredit.toString(),
      sourceType: entry.sourceType ?? null,
      sourceId: entry.sourceId ?? null,
      createdBy: actorId,
    })
    .returning({ id: schema.journalEntries.id });
  await tx.insert(schema.journalLines).values(
    lines.map((l, i) => ({
      journalEntryId: created!.id,
      companyId: company.id,
      lineNumber: i + 1,
      accountId: l.accountId,
      description: l.memo,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
    })),
  );
  const now = new Date();
  if (entry.status === 'POSTED') {
    await tx
      .update(schema.journalEntries)
      .set({
        status: 'POSTED',
        postingDate: entry.date,
        submittedBy: actorId,
        submittedAt: now,
        approvedBy: actorId,
        approvedAt: now,
        postedBy: actorId,
        postedAt: now,
      })
      .where(eq(schema.journalEntries.id, created!.id));
  } else {
    await tx
      .update(schema.journalEntries)
      .set({ status: 'SUBMITTED', submittedBy: actorId, submittedAt: now })
      .where(eq(schema.journalEntries.id, created!.id));
  }
  return created!.id;
}
