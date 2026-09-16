import type { SyncEntity } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import type { Integration } from '@/database/schema';
import type {
  ConnectorContext,
  IntegrationConnector,
  PushRequest,
  PushResult,
} from '../core/connector';
import { IntegrationError } from '../core/integration-error';
import type { MappingResult } from '../mapping/mapping.logic';
import {
  decodePosition,
  encodePosition,
  positionOf,
  type ExportRecord,
  type Exporter,
} from './exporters/exporter';
import { emptyCounters, type EntitySyncResult, type SyncCounters } from './sync-engine';

/** What the engine remembers about an earlier push of the same record. */
export interface PushedReference {
  externalId: string;
  pushedAt: string | null;
}

export interface EntityPushInput {
  connector: IntegrationConnector;
  ctx: ConnectorContext;
  integration: Integration;
  principal: AuthenticatedUser;
  entity: SyncEntity;
  /** INCREMENTAL resumes at the watermark and skips unchanged records; FULL re-sends everything. */
  mode: 'INCREMENTAL' | 'FULL';
  startCursor: string | null;
  batchSize: number;
  exporter: Exporter;
  /** Outbound mapping of the domain view; `output` is what the provider receives. */
  map: (record: ExportRecord) => Promise<MappingResult>;
  /** Earlier pushes of these records (by internal id). */
  existing: (internalIds: string[]) => Promise<Map<string, PushedReference>>;
  /** Persist the provider's answer for one record (its own transaction). */
  link: (record: ExportRecord, result: PushResult['results'][number]) => Promise<void>;
  /** Called after every pushed batch with the position to persist. */
  checkpoint: (cursor: string | null, counters: SyncCounters) => Promise<void>;
  /** Returns true when a cancel was requested (checked between batches). */
  cancelled: () => Promise<boolean>;
  maxFailureRatio?: number;
  maxBatches?: number;
}

const TRANSPORT_CODES = new Set([
  'TIMEOUT',
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'AUTHENTICATION_ERROR',
]);

/**
 * The export -> map -> push loop for one entity, the mirror of `syncEntity`.
 * Records are read in (updatedAt, id) order, mapped one by one (a bad
 * mapping fails alone), sent to the provider in batches, and every answer
 * is persisted as an external reference before the position is
 * checkpointed - so a crash mid-run resumes after the last batch the
 * provider acknowledged, and a record the provider already holds is sent
 * again only when it changed since (or on a FULL run).
 */
export async function pushEntity(input: EntityPushInput): Promise<EntitySyncResult> {
  const counters = emptyCounters();
  let position = decodePosition(input.startCursor);
  let lastCommitted = input.startCursor;
  let batches = 0;
  const maxBatches = input.maxBatches ?? 10_000;
  const maxFailureRatio = input.maxFailureRatio ?? 0.5;

  for (;;) {
    if (await input.cancelled())
      return {
        counters,
        lastCursor: lastCommitted,
        nextCursor: encodePosition(position),
        cancelled: true,
      };
    if (batches >= maxBatches) break;
    const page = await input.exporter.select(
      {
        integration: input.integration,
        principal: input.principal,
        companyId: input.integration.companyId ?? input.principal.companyId ?? '',
        provider: input.integration.provider,
        correlationId: input.ctx.correlationId,
      },
      { after: position, limit: input.batchSize },
    );
    batches += 1;
    if (!page.records.length) break;

    const prior = await input.existing(page.records.map((r) => r.internalId));
    const batch: PushRequest['records'] = [];
    const byId = new Map<string, ExportRecord>();
    for (const record of page.records) {
      counters.processed += 1;
      const ref = prior.get(record.internalId);
      if (
        input.mode === 'INCREMENTAL' &&
        ref?.pushedAt &&
        new Date(ref.pushedAt).getTime() >= record.updatedAt.getTime()
      ) {
        counters.skipped += 1;
        continue;
      }
      try {
        const mapped = await input.map(record);
        if (mapped.errors.length)
          throw new IntegrationError(
            'MAPPING_ERROR',
            mapped.errors.map((e) => `${e.target}: ${e.message}`).join('; '),
            { details: { errors: mapped.errors } },
          );
        batch.push({
          internalId: record.internalId,
          externalId: ref?.externalId ?? null,
          data: mapped.output,
        });
        byId.set(record.internalId, record);
      } catch (err) {
        recordFailure(counters, record, IntegrationError.from(err));
      }
    }

    if (batch.length) {
      if (!input.connector.push)
        throw new IntegrationError(
          'PROVIDER_ERROR',
          `${input.connector.descriptor.name} does not support pushing records.`,
        );
      let result: PushResult;
      try {
        result = await input.connector.push(input.ctx, { entity: input.entity, records: batch });
      } catch (err) {
        // Transport / auth failures abort the run and are retried as a whole; the
        // position stays at the last acknowledged batch.
        const ie = IntegrationError.from(err);
        if (TRANSPORT_CODES.has(ie.code)) throw ie;
        for (const entry of batch) recordFailure(counters, byId.get(entry.internalId)!, ie);
        result = { results: [] };
        batch.length = 0;
      }
      const answered = new Map(result.results.map((r) => [r.internalId, r]));
      for (const entry of batch) {
        const record = byId.get(entry.internalId)!;
        const answer = answered.get(entry.internalId);
        if (!answer) {
          recordFailure(
            counters,
            record,
            new IntegrationError(
              'PROVIDER_ERROR',
              'The provider returned no result for the record.',
            ),
          );
          continue;
        }
        if (!answer.ok) {
          recordFailure(
            counters,
            record,
            new IntegrationError('VALIDATION_ERROR', answer.error ?? 'Rejected by the provider.'),
          );
          continue;
        }
        await input.link(record, answer);
        if (prior.has(record.internalId)) counters.updated += 1;
        else counters.created += 1;
      }
    }

    position = positionOf(page.records[page.records.length - 1]!);
    lastCommitted = encodePosition(position);
    await input.checkpoint(lastCommitted, counters);
    if (counters.processed >= 20 && counters.failed / counters.processed > maxFailureRatio)
      throw new IntegrationError(
        'VALIDATION_ERROR',
        `More than ${Math.round(maxFailureRatio * 100)}% of records were rejected; stopping.`,
        { details: { failed: counters.failed, processed: counters.processed } },
      );
    if (!page.hasMore) break;
  }
  return { counters, lastCursor: lastCommitted, nextCursor: lastCommitted, cancelled: false };
}

function recordFailure(counters: SyncCounters, record: ExportRecord, error: IntegrationError) {
  counters.failed += 1;
  if (counters.failures.length < 100)
    counters.failures.push({
      externalId: record.label,
      code: error.code,
      message: error.message.slice(0, 300),
    });
}
