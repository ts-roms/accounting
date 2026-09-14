import type { SyncEntity } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import type { Integration } from '@/database/schema';
import type { ConnectorContext, ExternalRecord, IntegrationConnector } from '../core/connector';
import { IntegrationError } from '../core/integration-error';
import type { MappingResult } from '../mapping/mapping.logic';
import type { ImportOutcome, Importer } from './importers/importer';

export interface SyncCounters {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  failures: Array<{ externalId: string | null; code: string; message: string }>;
}

export interface EntitySyncInput {
  connector: IntegrationConnector;
  ctx: ConnectorContext;
  integration: Integration;
  principal: AuthenticatedUser;
  entity: SyncEntity;
  mode: 'INCREMENTAL' | 'FULL';
  startCursor: string | null;
  batchSize: number;
  importer: Importer;
  map: (record: ExternalRecord) => Promise<MappingResult>;
  /** Called after every committed batch with the checkpoint to persist. */
  checkpoint: (cursor: string | null, counters: SyncCounters) => Promise<void>;
  /** Returns true when a cancel was requested (checked between batches). */
  cancelled: () => Promise<boolean>;
  /** Per-record failures beyond this ratio abort the run as MAPPING_ERROR / VALIDATION_ERROR. */
  maxFailureRatio?: number;
  maxBatches?: number;
}

export interface EntitySyncResult {
  counters: SyncCounters;
  lastCursor: string | null;
  nextCursor: string | null;
  cancelled: boolean;
}

export function emptyCounters(): SyncCounters {
  return { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, failures: [] };
}

/**
 * The pull -> map -> import loop for one entity. Each record is imported in
 * its own domain transaction, so a bad record fails alone; the cursor is
 * checkpointed after each batch, so a run that dies at record 4,521 resumes
 * from the last committed batch and the external references make re-imports
 * of the overlap idempotent.
 */
export async function syncEntity(input: EntitySyncInput): Promise<EntitySyncResult> {
  const counters = emptyCounters();
  let cursor = input.startCursor;
  let lastCommitted = input.startCursor;
  let batches = 0;
  const maxBatches = input.maxBatches ?? 10_000;
  const maxFailureRatio = input.maxFailureRatio ?? 0.5;

  for (;;) {
    if (await input.cancelled())
      return { counters, lastCursor: lastCommitted, nextCursor: cursor, cancelled: true };
    if (batches >= maxBatches) break;
    const page = await input.connector.pull(input.ctx, {
      entity: input.entity,
      cursor,
      limit: input.batchSize,
      mode: input.mode,
    });
    batches += 1;
    for (const record of page.records) {
      counters.processed += 1;
      try {
        const outcome = await importRecord(input, record);
        if (outcome.action === 'CREATED') counters.created += 1;
        else if (outcome.action === 'UPDATED') counters.updated += 1;
        else counters.skipped += 1;
      } catch (err) {
        const ie = IntegrationError.from(err);
        // Transport-level failures abort the run (and are retried as a whole); record-level ones are collected.
        if (
          ie.code === 'TIMEOUT' ||
          ie.code === 'NETWORK_ERROR' ||
          ie.code === 'RATE_LIMITED' ||
          ie.code === 'AUTHENTICATION_ERROR'
        )
          throw ie;
        counters.failed += 1;
        if (counters.failures.length < 100)
          counters.failures.push({
            externalId: record.externalId,
            code: ie.code,
            message: ie.message.slice(0, 300),
          });
      }
    }
    lastCommitted = page.nextCursor ?? cursor ?? null;
    cursor = page.nextCursor;
    await input.checkpoint(lastCommitted, counters);
    if (counters.processed >= 20 && counters.failed / counters.processed > maxFailureRatio)
      throw new IntegrationError(
        'VALIDATION_ERROR',
        `More than ${Math.round(maxFailureRatio * 100)}% of records failed; stopping.`,
        {
          details: { failed: counters.failed, processed: counters.processed },
        },
      );
    if (!page.hasMore || !page.nextCursor) break;
  }
  return {
    counters,
    lastCursor: lastCommitted,
    nextCursor: cursor ?? lastCommitted,
    cancelled: false,
  };
}

async function importRecord(
  input: EntitySyncInput,
  record: ExternalRecord,
): Promise<ImportOutcome> {
  const mapped = await input.map(record);
  if (mapped.errors.length)
    throw new IntegrationError(
      'MAPPING_ERROR',
      mapped.errors.map((e) => `${e.target}: ${e.message}`).join('; '),
      {
        details: { errors: mapped.errors },
      },
    );
  return input.importer.import(
    {
      integration: input.integration,
      principal: input.principal,
      companyId: input.integration.companyId ?? input.principal.companyId ?? '',
      provider: input.integration.provider,
      correlationId: input.ctx.correlationId,
    },
    record,
    mapped.output,
  );
}
