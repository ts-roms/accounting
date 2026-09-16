import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import type { Integration } from '@/database/schema';
import type { ConnectorContext, IntegrationConnector, PushRequest } from '../core/connector';
import { IntegrationError } from '../core/integration-error';
import { decodePosition, type ExportRecord, type Exporter } from './exporters/exporter';
import { pushEntity, type EntityPushInput, type PushedReference } from './push-engine';

const T0 = Date.UTC(2026, 2, 1);

function record(n: number, minutes = n): ExportRecord {
  return {
    internalId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    updatedAt: new Date(T0 + minutes * 60_000),
    label: `DOC-${n}`,
    data: { documentNumber: `DOC-${n}`, total: `${n}.0000` },
  };
}

/** In-memory exporter: keyset pagination over a fixed list, like the real ones. */
function exporterOf(records: ExportRecord[]): Exporter & { calls: number } {
  const ex = {
    entity: 'invoices' as const,
    calls: 0,
    async select(
      _ctx: unknown,
      q: { after: { updatedAt: string; id: string } | null; limit: number },
    ) {
      ex.calls += 1;
      const after = q.after;
      const rest = records
        .filter(
          (r) =>
            !after ||
            r.updatedAt.toISOString() > after.updatedAt ||
            (r.updatedAt.toISOString() === after.updatedAt && r.internalId > after.id),
        )
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
      return { records: rest.slice(0, q.limit), hasMore: rest.length > q.limit };
    },
  };
  return ex;
}

function harness(opts: {
  records: ExportRecord[];
  prior?: Map<string, PushedReference>;
  mode?: 'INCREMENTAL' | 'FULL';
  startCursor?: string | null;
  batchSize?: number;
  push?: IntegrationConnector['push'];
  cancelAfterBatches?: number;
}) {
  const pushed: PushRequest[] = [];
  const linked: Array<{ internalId: string; externalId: string | null }> = [];
  const checkpoints: Array<string | null> = [];
  const prior = opts.prior ?? new Map<string, PushedReference>();
  let batches = 0;
  const connector = {
    descriptor: { name: 'Fake' },
    push:
      opts.push ??
      (async (_ctx: ConnectorContext, req: PushRequest) => {
        pushed.push(req);
        return {
          results: req.records.map((r) => ({
            internalId: r.internalId,
            externalId: r.externalId ?? `EXT-${r.internalId.slice(-2)}`,
            ok: true,
          })),
        };
      }),
  } as unknown as IntegrationConnector;
  const input: EntityPushInput = {
    connector,
    ctx: { correlationId: 'c' } as ConnectorContext,
    integration: { id: 'int', provider: 'FAKE', companyId: 'co' } as Integration,
    principal: { id: 'u', companyId: 'co' } as AuthenticatedUser,
    entity: 'invoices',
    mode: opts.mode ?? 'INCREMENTAL',
    startCursor: opts.startCursor ?? null,
    batchSize: opts.batchSize ?? 2,
    exporter: exporterOf(opts.records),
    map: async (r) =>
      r.label === 'DOC-BAD'
        ? { output: {}, errors: [{ target: 'total', message: 'missing' }] }
        : { output: { number: r.data.documentNumber }, errors: [] },
    existing: async (ids) => new Map([...prior].filter(([id]) => ids.includes(id))),
    link: async (r, answer) => {
      linked.push({ internalId: r.internalId, externalId: answer.externalId });
      prior.set(r.internalId, {
        externalId: answer.externalId ?? 'none',
        pushedAt: new Date().toISOString(),
      });
    },
    checkpoint: async (cursor) => {
      checkpoints.push(cursor);
      batches += 1;
    },
    cancelled: async () =>
      opts.cancelAfterBatches !== undefined && batches >= opts.cancelAfterBatches,
  };
  return { input, pushed, linked, checkpoints };
}

describe('pushEntity', () => {
  it('exports in batches, maps, pushes, links every acknowledged record and checkpoints the position', async () => {
    const h = harness({ records: [record(1), record(2), record(3)] });
    const result = await pushEntity(h.input);
    expect(result.counters).toMatchObject({ processed: 3, created: 3, failed: 0, skipped: 0 });
    expect(h.pushed.map((p) => p.records.length)).toEqual([2, 1]);
    expect(h.pushed[0]!.records[0]!.data).toEqual({ number: 'DOC-1' });
    expect(h.linked).toHaveLength(3);
    expect(h.checkpoints).toHaveLength(2);
    expect(decodePosition(result.lastCursor)).toEqual({
      updatedAt: record(3).updatedAt.toISOString(),
      id: record(3).internalId,
    });
  });

  it('skips records unchanged since their last push (incremental) but re-sends them on FULL', async () => {
    const pushedAt = new Date(T0 + 10 * 60_000).toISOString();
    const prior = new Map<string, PushedReference>([
      [record(1).internalId, { externalId: 'EXT-A', pushedAt }],
      [record(20).internalId, { externalId: 'EXT-B', pushedAt }], // changed after the push
    ]);
    const inc = harness({ records: [record(1), record(20)], prior: new Map(prior) });
    const r1 = await pushEntity(inc.input);
    expect(r1.counters).toMatchObject({ processed: 2, skipped: 1, updated: 1, created: 0 });
    expect(inc.pushed[0]!.records).toEqual([
      expect.objectContaining({ internalId: record(20).internalId, externalId: 'EXT-B' }),
    ]);

    const full = harness({ records: [record(1), record(20)], prior: new Map(prior), mode: 'FULL' });
    const r2 = await pushEntity(full.input);
    expect(r2.counters).toMatchObject({ processed: 2, skipped: 0, updated: 2 });
  });

  it('records mapping errors and provider rejections per record without stopping the run', async () => {
    const bad = { ...record(2), label: 'DOC-BAD' };
    const h = harness({
      records: [record(1), bad, record(3)],
      batchSize: 10,
      push: async (_ctx, req) => ({
        results: req.records.map((r) => ({
          internalId: r.internalId,
          externalId: null,
          ok: r.internalId !== record(3).internalId,
          error: r.internalId === record(3).internalId ? 'duplicate submission' : undefined,
        })),
      }),
    });
    const result = await pushEntity(h.input);
    expect(result.counters).toMatchObject({ processed: 3, created: 1, failed: 2 });
    expect(result.counters.failures).toEqual([
      expect.objectContaining({ externalId: 'DOC-BAD', code: 'MAPPING_ERROR' }),
      expect.objectContaining({ externalId: 'DOC-3', code: 'VALIDATION_ERROR' }),
    ]);
    expect(h.linked).toEqual([{ internalId: record(1).internalId, externalId: null }]);
  });

  it('aborts on transport errors keeping the last acknowledged position, so a retry resumes there', async () => {
    let calls = 0;
    const h = harness({
      records: [record(1), record(2), record(3), record(4)],
      push: async (_ctx, req) => {
        calls += 1;
        if (calls === 2) throw new IntegrationError('NETWORK_ERROR', 'connection reset');
        return {
          results: req.records.map((r) => ({
            internalId: r.internalId,
            externalId: 'X',
            ok: true,
          })),
        };
      },
    });
    await expect(pushEntity(h.input)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(h.linked).toHaveLength(2);
    expect(h.checkpoints).toEqual([
      JSON.stringify({ updatedAt: record(2).updatedAt.toISOString(), id: record(2).internalId }),
    ]);
    // Resume from that checkpoint: only records 3 and 4 are exported.
    const resumed = harness({
      records: [record(1), record(2), record(3), record(4)],
      startCursor: h.checkpoints[0],
    });
    const result = await pushEntity(resumed.input);
    expect(result.counters.processed).toBe(2);
  });

  it('pauses between batches when cancelled', async () => {
    const h = harness({ records: [record(1), record(2), record(3)], cancelAfterBatches: 1 });
    const result = await pushEntity(h.input);
    expect(result.cancelled).toBe(true);
    expect(result.counters.processed).toBe(2);
  });
});
