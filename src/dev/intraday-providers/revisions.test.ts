import { describe, expect, it } from 'vitest';
import { chain } from './revisions.js';
import { Versions, type Observation, type Prices } from './model.js';

const startAt = '2026-09-23T13:30:00.000Z';
const time = (s: number) => new Date(Date.parse(startAt) + s * 1000).toISOString();
const initial: Prices = { open: 100, high: 101, low: 99, close: 100, volume: 100 };
function observations(entries: { second: number; requested: number; values?: Prices }[]) {
  const versions = new Versions('run');
  return entries.map(e => versions.observe({ product: 'TIINGO_REST', symbol: 'SPY', startAt, providerTimestamp: startAt,
    price: null, values: e.values ?? initial }, { requestedAt: time(e.requested), receivedAt: time(e.second), connectionEpoch: 0, monotonicOffsetMs: e.second * 1000 }));
}
describe('offline Tiingo REST version forensics', () => {
  it('separates duplicates, partial evolution, first completion, and post-close A-B-A', () => {
    const b = { ...initial, close: 100.5 };
    const c = chain(observations([{ second: 10, requested: 9 }, { second: 20, requested: 19 },
      { second: 30, requested: 29, values: b }, { second: 61, requested: 60, values: b },
      { second: 80, requested: 79, values: initial }, { second: 90, requested: 89, values: b }]));
    expect(c.transitions.map(t => t.kind)).toEqual(['PRE_CLOSE_EVOLUTION', 'DUPLICATE', 'PRE_CLOSE_EVOLUTION',
      'FIRST_COMPLETED_VERSION', 'POST_CLOSE_REVISION', 'POST_CLOSE_REVISION']);
    expect(c.firstCompleted?.values?.close).toBe(100.5);
    expect(c.finalObserved?.values?.close).toBe(100.5);
    expect(c.timing.firstCompletedRequestLagMs).toBe(0);
    expect(c.timing.firstPostCloseReceiptLagMs).toBe(20000);
    expect(c.timing.firstToFinalReceiptMs).toBe(29000);
  });
  it.each(['open', 'high', 'low', 'close', 'volume'] as const)('reports an isolated %s field change', field => {
    const replacement = { ...initial, [field]: field === 'low' ? 98 : field === 'volume' ? 200 : field === 'open' ? 100.5 : field === 'high' ? 102 : 100.5 };
    const c = chain(observations([{ second: 61, requested: 60 }, { second: 121, requested: 120, values: replacement }]));
    expect(c.transitions[1]!.changedFields).toEqual([field]);
    const d = c.transitions[1]!.changes![field]!;
    expect('absolute' in d && d.absolute).toBe(field === 'volume' ? 100 : field === 'low' || field === 'high' ? 1 : .5);
    if ('bps' in d && field !== 'volume') expect(d.bps).toBeCloseTo((replacement[field] / initial[field] - 1) * 10000);
  });
  it('keeps zero-denominator volume percent null and multiple field changes', () => {
    const a = { ...initial, volume: 0 }, b = { ...initial, high: 102, close: 100.5, volume: 10 };
    const c = chain(observations([{ second: 61, requested: 60, values: a }, { second: 121, requested: 120, values: b }]));
    expect(c.transitions[1]!.changedFields).toEqual(['high', 'close', 'volume']);
    expect(c.transitions[1]!.changes!.volume).toMatchObject({ percent: null, signed: 10 });
  });
  it('selects last completed version even after an identical overlap', () => {
    const rows: Observation[] = observations([{ second: 10, requested: 9 }, { second: 61, requested: 60 }, { second: 121, requested: 120 }]);
    const c = chain(rows);
    expect(c.broadRevisionCount).toBe(0);
    expect(c.firstCompleted?.ordinal).toBe(2);
    expect(c.finalObserved?.ordinal).toBe(3);
    expect(c.transitions.at(-1)?.kind).toBe('DUPLICATE');
  });
});
