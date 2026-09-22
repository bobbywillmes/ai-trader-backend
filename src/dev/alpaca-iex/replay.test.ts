import { describe, expect, it } from 'vitest';
import { analyze } from './analyze.js';
import { manifest } from './journal.js';
import { normalize, validateObservation } from './model.js';
import type { Observation } from './model.js';
import { replay, windows } from './replay.js';
import { sessionPlan } from './session.js';

const plan = sessionPlan('2026-09-22');
const start = Date.parse(plan.openAt);
export function fixture(minute: number, ordinal = minute + 1, override: Record<string, unknown> = {}, envelope: Partial<Observation> = {}): Observation {
  const parsed = normalize({ T: 'b', S: 'SPY', t: new Date(start + minute * 60_000).toISOString(), o: 100, h: 103, l: 99, c: 102, v: 10, n: 2, vw: 101, ...override },
    { runId: 'test', connectionEpoch: 1, ordinal, frameOrdinal: ordinal, elementIndex: 0,
      receivedAt: new Date(start + (minute + 1) * 60_000 + 1000).toISOString(), monotonicOffsetMs: ordinal, ...envelope });
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.observation;
}
const normal = () => Array.from({ length: 15 }, (_, i) => fixture(i));
const cutoff = '2026-09-22T14:00:00.000Z';
const first = (data: Observation[], at = cutoff) => windows(replay(data, at), plan)[0]!;

describe('pure IEX replay and anchored aggregation', () => {
  it('aggregates exactly 15 distinct minutes with provenance', () => {
    const w = first(normal());
    expect(w.completeness).toBe('COMPLETE_INITIAL'); expect(w.aggregate).toEqual({ open: 100, high: 103, low: 99, close: 102, volume: 150 });
    expect(w.constituents).toHaveLength(15); expect(w.targetAt).toBe('2026-09-22T13:45:00.000Z');
  });
  it('retains identical duplicates without double counting', () => {
    const rows = [...normal(), fixture(0, 16)];
    expect(first(rows).aggregate!.volume).toBe(150);
    const minute = replay(rows, cutoff).get(`SPY/${plan.openAt}`)!;
    expect(minute.observations).toHaveLength(2); expect(minute.versions).toHaveLength(1); expect(minute.duplicateCount).toBe(1);
  });
  it('flags conflicting initial bars without choosing a replacement', () => {
    const rows = [...normal(), fixture(0, 16, { c: 101 })];
    expect(first(rows).ambiguous).toBe(true); expect(first(rows).aggregate!.open).toBe(100);
    expect(analyze(manifest('test', plan.openAt, plan, 'a'.repeat(40)), rows, [], cutoff).windowCompleteness.complete).toBe(0);
  });
  it('replays repeated updates, including final-minute updates, without future leakage', () => {
    const rows = [...normal(), fixture(14, 16, { T: 'u', c: 101, v: 20 }, { receivedAt: '2026-09-22T13:45:30.000Z' }),
      fixture(14, 17, { T: 'u', c: 100, v: 30 }, { receivedAt: '2026-09-22T13:46:30.000Z' })];
    expect(first(rows, '2026-09-22T13:45:29.999Z').aggregate!.close).toBe(102);
    expect(first(rows, '2026-09-22T13:45:30.000Z').aggregate!.close).toBe(101);
    expect(first(rows).aggregate!.close).toBe(100); expect(first(rows).aggregate!.volume).toBe(170);
    expect(first(rows).completeness).toBe('COMPLETE_AFTER_UPDATE');
    const report = analyze(manifest('test', plan.openAt, plan, 'a'.repeat(40)), rows, [], cutoff);
    expect(report.windows[0]!.versions.filter(v => v.state.aggregate)).toHaveLength(3);
    expect(report.windows[0]!.correctedConstituentMinutes).toBe(1);
    expect(report.windows[0]!.firstCompleteLatencyMs).toBe(1000);
    expect(report.windows[0]!.latestCorrectionLatencyMs).toBe(90_000);
    expect(report.windows[0]!.initialToLatestDelta!.volume).toBe(20);
    expect(report.candidateCutoffs[0]!.snapshots[0]!.changedLater).toBe(true);
  });
  it('keeps u-before-b and reports missing initial independently', () => {
    const update = fixture(0, 1, { T: 'u', c: 101 });
    expect([...replay([update], cutoff).values()][0]!.initialMissing).toBe(true);
    const state = [...replay([update, fixture(0, 2)], cutoff).values()][0]!;
    expect(state.selected.close).toBe(101); expect(state.initialMissing).toBe(false);
  });
  it('handles shuffled input and out-of-order minutes by local ordinal and interval time', () => {
    const rows = normal().reverse().map((o, i) => ({ ...o, ordinal: i + 1 }));
    expect(first(rows).aggregate).toEqual(first(normal()).aggregate);
  });
  it.each([0, 7])('does not synthesize missing minute %s', minute => {
    const w = first(normal().filter((_, i) => i !== minute));
    expect(w.completeness).toBe('INCOMPLETE'); expect(w.aggregate).toBeNull(); expect(w.missingMinutes).toHaveLength(1);
  });
  it('handles reconnects across minutes and flags conflicting cross-epoch updates', () => {
    const rows = normal().map(o => ({ ...o, connectionEpoch: o.ordinal > 7 ? 2 : 1 }));
    expect(first(rows).completeness).toBe('COMPLETE_INITIAL');
    rows.push(fixture(0, 16, { T: 'u', v: 20 }, { connectionEpoch: 1 }), fixture(0, 17, { T: 'u', v: 30 }, { connectionEpoch: 2 }));
    expect(first(rows).ambiguous).toBe(true); expect(first(rows).aggregate!.volume).toBe(170);
  });
  it('ignores extended hours, preserves closing window as non-actionable', () => {
    const data = [fixture(-1, 100), ...normal(), fixture(390, 101)];
    expect(first(data).aggregate!.volume).toBe(150);
    expect(windows(replay(data, '2026-09-22T23:00:00Z'), plan).filter(w => !w.actionableTarget)).toHaveLength(2);
  });
  it('uses verified early closes, DST and known calendar coverage', () => {
    const early = sessionPlan('2026-11-27');
    expect(early.openAt).toBe('2026-11-27T14:30:00.000Z'); expect(early.closeAt).toBe('2026-11-27T18:00:00.000Z');
    expect(windows(new Map(), early)).toHaveLength(28);
    expect(sessionPlan('2026-03-06').openAt).toContain('14:30'); expect(sessionPlan('2026-03-09').openAt).toContain('13:30');
    expect(() => sessionPlan('2027-01-04')).toThrow(); expect(() => sessionPlan('2026-12-25')).toThrow();
  });
  it('reports all scheduled windows, censored cutoffs and missing RSP', () => {
    const report = analyze(manifest('test', plan.openAt, plan, 'a'.repeat(40)), normal(), [], '2026-09-22T13:45:30Z');
    expect(report.minuteCompleteness.RSP!.missing).toBe(390);
    expect(report.candidateCutoffs[0]!.perSymbol.SPY!.complete).toBe(1);
    expect(report.candidateCutoffs[0]!.paired.complete).toBe(0);
    expect(report.candidateCutoffs[1]!.perSymbol.SPY!.complete).toBe(0);
    expect(report.candidateCutoffs[0]!.perSymbol.SPY!.scheduled).toBe(26);
  });
  it('retains uncertainty for a disconnect after initial completion and before corrections', () => {
    const rows = [...normal(), fixture(14, 16, { T: 'u', c: 101 }, { receivedAt: '2026-09-22T13:46:00Z', connectionEpoch: 2 })];
    const report = analyze(manifest('test', plan.openAt, plan, 'a'.repeat(40)), rows, [
      { type: 'subscription_confirmed', at: '2026-09-22T13:29:00Z', connectionEpoch: 1 },
      { type: 'socket_closed', at: '2026-09-22T13:45:10Z', connectionEpoch: 1 },
      { type: 'subscription_confirmed', at: '2026-09-22T13:45:40Z', connectionEpoch: 2 },
    ], cutoff);
    expect(report.windows[0]!.firstCompleteLatencyMs).toBe(1000);
    expect(report.windows[0]!.transportCoverage).toBe('UNCERTAIN'); expect(report.windows[0]!.ambiguous).toBe(true);
    expect(report.reconnectGaps[0]!.durationMs).toBe(30_000);
  });
  it('retains a changed constituent version even when aggregate OHLCV is unchanged', () => {
    const rows = [...normal(), fixture(7, 16, { T: 'u', c: 101 }, { receivedAt: '2026-09-22T13:45:30Z' }),
      fixture(7, 17, { T: 'u', c: 100 }, { receivedAt: '2026-09-22T13:46:00Z' }),
      fixture(7, 18, { T: 'u', c: 100 }, { receivedAt: '2026-09-22T13:47:00Z' })];
    const report = analyze(manifest('test', plan.openAt, plan, 'a'.repeat(40)), rows, [], cutoff);
    expect(report.windows[0]!.versions.filter(v => v.state.aggregate)).toHaveLength(3);
    expect(report.windows[0]!.lastValueChangingCorrectionAt).toBe('2026-09-22T13:46:00.000Z');
    expect(report.windows[0]!.latestCorrectionLatencyMs).toBe(60_000);
    expect(report.windows[0]!.initialToLatestDelta!.close).toBe(0);
  });
  it('excludes clock-jump runs from latency acceptance without hiding diagnostics', () => {
    const report = analyze(manifest('test', plan.openAt, plan, 'a'.repeat(40)), normal(), [
      { type: 'clock_jump', at: '2026-09-22T13:40:00Z', connectionEpoch: 1 },
    ], cutoff);
    expect(report.clockUncertain).toBe(true); expect(report.latencyEligible).toBe(false); expect(report.latencyMs.initial.count).toBe(15);
  });
});

describe('normalization boundary', () => {
  it.each(['bad', '2026-02-30T13:30:00Z', '2026-09-22T13:30:01Z', '2026-09-22T13:30:00.000000001Z', '2026-09-22 13:30:00Z'])('rejects malformed timestamp %s', t => {
    expect(() => fixture(0, 1, { t })).toThrow('malformed_frame');
  });
  it.each([{ v: -1 }, { v: Number.MAX_SAFE_INTEGER + 1 }, { v: 1.5 }, { n: 1.5 }, { h: 99 }, { l: 104 }, { o: Infinity }, { c: '102' }])('rejects invalid numeric data %j', override => {
    expect(() => fixture(0, 1, override)).toThrow('malformed_frame');
  });
  it('rejects unexpected symbols/types and detects journal tampering', () => {
    expect(() => fixture(0, 1, { S: 'AAPL' })).toThrow('unexpected_symbol');
    expect(() => fixture(0, 1, { T: 'q' })).toThrow('unexpected_channel');
    expect(() => validateObservation({ ...fixture(0), volume: 20 })).toThrow();
    expect(validateObservation(fixture(0))).toEqual(fixture(0));
  });
});
