import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DocumentType } from '@accounting/types';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { documentSequences } from '@/database/schema';

const DEFAULT_PREFIX: Record<DocumentType, string> = {
  JE: 'JE',
  INV: 'INV',
  CN: 'CN',
  DN: 'DN',
  RCP: 'RCP',
  BILL: 'BILL',
  VCN: 'VCN',
  VDN: 'VDN',
  PAY: 'PAY',
  QT: 'QT',
  SO: 'SO',
  PR: 'PR',
  PO: 'PO',
  GR: 'GR',
  SRN: 'SRN',
  PRN: 'PRN',
  ADJ: 'ADJ',
  TRF: 'TRF',
  CNT: 'CNT',
  FA: 'FA',
  DEP: 'DEP',
  BTX: 'BTX',
  STM: 'STM',
  EXP: 'EXP',
  ICT: 'ICT',
  FXR: 'FXR',
  DLV: 'DLV',
  WO: 'WO',
  COL: 'COL',
  DSP: 'DSP',
  RFD: 'RFD',
  PRV: 'PRV',
  STMT: 'STMT',
};

/**
 * Configurable document numbering: `<PREFIX>-<YEAR>-<NNNNNN>` per company,
 * document type and fiscal year. Allocation is a single atomic upsert so two
 * concurrent transactions can never receive the same number.
 */
@Injectable()
export class DocumentNumberingService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async allocate(
    companyId: string,
    documentType: DocumentType,
    year: number,
    executor: DbExecutor = this.db,
  ): Promise<string> {
    const [row] = await executor
      .insert(documentSequences)
      .values({
        companyId,
        documentType,
        year,
        prefix: DEFAULT_PREFIX[documentType],
        nextNumber: 2,
      })
      .onConflictDoUpdate({
        target: [
          documentSequences.companyId,
          documentSequences.documentType,
          documentSequences.year,
        ],
        set: { nextNumber: sql`${documentSequences.nextNumber} + 1`, updatedAt: new Date() },
      })
      .returning({
        prefix: documentSequences.prefix,
        nextNumber: documentSequences.nextNumber,
        padding: documentSequences.padding,
      });
    if (!row) throw new Error('Sequence allocation returned no row');
    // The row now holds the NEXT number; the allocated one is next - 1.
    const allocated = row.nextNumber - 1;
    return `${row.prefix}-${year}-${String(allocated).padStart(row.padding, '0')}`;
  }
}
