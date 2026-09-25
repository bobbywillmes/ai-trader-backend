import { describe, expect, it } from 'vitest';
import { chain } from './revisions.js';
import { Versions, type Observation, type Prices } from './model.js';
import { measure, windowsAt, type Source } from './compare.js';
import { sessionPlan } from '../alpaca-iex/session.js';
import type { Baseline } from '../alpaca-iex/baseline.js';
import { advanceIntradayStress, marketRawState } from '../../services/intraday-stress-calculation.js';

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
    expect(c.transitions.map(t => t.kind)).toEqual(['INITIAL_PARTIAL_VERSION', 'DUPLICATE', 'PRE_CLOSE_EVOLUTION',
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
  it('propagates a revised final minute through strict 15-minute OHLC and V1 state without changing an earlier view', () => {
    const plan = sessionPlan('2026-09-23');
    const baseline = { sessionDate: plan.date, calendarHash: plan.calendarHash, priorAtr14Pct: { SPY: .01, RSP: .01 } } as Baseline;
    const versions = new Versions('run'), rows: Observation[] = [];
    const quiet = { open: 100, high: 100.1, low: 99.9, close: 100, volume: 100 };
    for (let minute = 0; minute < 30; minute++) for (const symbol of ['SPY', 'RSP'] as const) {
      const at = new Date(Date.parse(startAt) + minute * 60000).toISOString();
      rows.push(versions.observe({ product: 'TIINGO_REST', symbol, startAt: at, providerTimestamp: at,
        price: null, values: { ...quiet } }, { requestedAt: new Date(Date.parse(at) + 60000).toISOString(),
        receivedAt: new Date(Date.parse(at) + 61000).toISOString(), connectionEpoch: 0, monotonicOffsetMs: minute * 60000 + 61000 }));
    }
    const revisedAt = new Date(Date.parse(startAt) + 14 * 60000).toISOString();
    const revision = versions.observe({ product: 'TIINGO_REST', symbol: 'SPY', startAt: revisedAt, providerTimestamp: revisedAt,
      price: null, values: { ...quiet, low: 95, close: 95 } },
    { requestedAt: time(1900), receivedAt: time(1901), connectionEpoch: 0, monotonicOffsetMs: 1901000 });
    const source = (observations: Observation[]): Source => ({ key: 'TIINGO_REST', product: 'TIINGO_REST',
      observations, startedAt: startAt, end: time(2000), events: [] });
    const before = windowsAt(source(rows), plan, time(2000));
    const after = windowsAt(source([...rows, revision]), plan, time(2000));
    const spyBefore = before.find(w => w.symbol === 'SPY' && w.startAt === startAt)!;
    const spyAfter = after.find(w => w.symbol === 'SPY' && w.startAt === startAt)!;
    expect(spyBefore.values?.close).toBe(100);
    expect(spyAfter.values?.close).toBe(95);
    expect(spyAfter.values?.high).toBe(spyBefore.values?.high);
    const old = measure(plan, before, baseline), changed = measure(plan, after, baseline);
    expect(old[0]![0]!.instrumentRawState).toBe('NORMAL');
    expect(changed[0]![0]!.instrumentRawState).toBe('SEVERE');
    const rawBefore = marketRawState(old[0]![0]!.instrumentRawState!, old[1]![0]!.instrumentRawState!);
    const rawAfter = marketRawState(changed[0]![0]!.instrumentRawState!, changed[1]![0]!.instrumentRawState!);
    expect(advanceIntradayStress({ effectiveState: null, confirmation: 0 }, rawBefore).effectiveState).toBe('NORMAL');
    expect(advanceIntradayStress({ effectiveState: null, confirmation: 0 }, rawAfter).effectiveState).toBe('SEVERE');
    expect(windowsAt(source([...rows, revision]), plan, time(950)).find(w => w.symbol === 'SPY' && w.startAt === startAt)?.values?.close).toBe(100);
  });
});
