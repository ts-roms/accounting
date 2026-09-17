import type { SyncEntity } from '@accounting/types';
import type { ImportContext } from '../importers/importer';

/** Same principal / integration context as an import; exporters only read. */
export type ExportContext = ImportContext;

/** An internal record ready to be mapped and pushed. */
export interface ExportRecord {
  internalId: string;
  /** Last domain change; drives incremental pushes and "unchanged since last push" skips. */
  updatedAt: Date;
  /** Human identity for job failure lists (document number, code, SKU). */
  label: string;
  data: Record<string, unknown>;
}

/**
 * Keyset position inside an export: records are ordered by (updatedAt, id)
 * so a run that dies mid-way resumes exactly after the last committed row,
 * and an incremental run starts at the watermark of the previous one.
 */
export interface ExportPosition {
  updatedAt: string;
  id: string;
}

export interface ExportQuery {
  /** Exclusive lower bound; null = from the beginning. */
  after: ExportPosition | null;
  limit: number;
}

export interface ExportPage {
  records: ExportRecord[];
  hasMore: boolean;
}

/**
 * Reads domain records for an outbound push. Exporters never mutate anything:
 * they select rows by (updatedAt, id) and hand the domain *view* (the same
 * shape the API returns) to the outbound mapping, so a provider payload is
 * always derived from what the books say, never from a parallel copy.
 */
export interface Exporter {
  readonly entity: SyncEntity;
  /** A page in (updatedAt, id) order; asserts the entity's read scope. */
  select(ctx: ExportContext, query: ExportQuery): Promise<ExportPage>;
  /** One record for a targeted (re-)push; null when it does not exist or is not exportable (e.g. a draft). */
  byId(ctx: ExportContext, internalId: string): Promise<ExportRecord | null>;
}

export const EXPORT_BATCH_SIZE = 50;

export function encodePosition(p: ExportPosition | null): string | null {
  return p ? JSON.stringify(p) : null;
}

export function decodePosition(cursor: string | null | undefined): ExportPosition | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as Partial<ExportPosition>;
    if (typeof parsed.updatedAt === 'string' && typeof parsed.id === 'string')
      return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    /* legacy or foreign cursor: start over */
  }
  return null;
}

export function positionOf(record: ExportRecord): ExportPosition {
  return { updatedAt: record.updatedAt.toISOString(), id: record.internalId };
}
