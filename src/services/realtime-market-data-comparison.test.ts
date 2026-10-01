import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareRealtimeEvidence, sessionSegment, summarizeComparisons, type ComparisonInputs } from './realtime-market-data-comparison.js';

const startedAt = new Date('2026-09-24T14:46:00Z');
const completedAt = new Date('2026-09-24T14:46:02Z');
const t = (minute: number) => `2026-09-24T14:${String(minute).padStart(2, '0')}:00.000Z`;
const minute = (n: number, close: number, volume: number) => ({ time: t(n), open: close, high: close + 1, low: close - 1, close, volume, vwap: close });
const bar = (n: number, close: number, volume: number) => ({ barStartAt: new Date(t(n)), open: close, high: close + 1, low: close - 1, close, volume });
const input: ComparisonInputs = { symbol: 'SPY', startedAt, completedAt,
  massive: { ok: true, fetchedAt: new Date('2026-09-24T14:46:01Z'), value: { symbol: 'SPY', from: null, to: null, extendedHoursRequested: true,
    snapshot: { symbol: 'SPY', lastPrice: 100, previousClose: 99, intradayHigh: 102, intradayLow: 98,
      dayVolume: 1000, sessionVwap: 100.5, updatedTime: '2026-09-24T14:31:34Z', observationSource: 'LAST_TRADE' },
    minuteBars: [minute(30, 99, 10), minute(31, 100, 20)], rawPayload: { snapshot: null, aggregates: null } } },
  consolidated: { ok: true, fetchedAt: completedAt, value: { provider: 'TIINGO_CONSOLIDATED', symbol: 'SPY',
    observedAt: new Date('2026-09-24T14:46:03Z'), fetchedAt: completedAt, referencePrice: 103,
    referencePriceSource: 'TNGO_LAST', previousClose: 99, open: 99, high: 104, low: 97, volume: 90, extendedHours: true } },
  iex: { ok: true, fetchedAt: completedAt, value: { provider: 'TIINGO_IEX', symbol: 'SPY',
    observedAt: new Date('2026-09-24T14:46:01Z'), fetchedAt: completedAt, referencePrice: 102,
    referencePriceSource: 'TNGO_LAST', previousClose: 99, open: null, high: 104, low: 98, volume: null, extendedHours: true } },
  history: { ok: true, fetchedAt: completedAt, value: [bar(30, 99.1, 11), bar(31, 100.2, 22), bar(32, 101, 33), bar(45, 103, 40)] } };

describe('read-only realtime comparison', () => {
  it('separates current snapshots from an exact-minute delayed Massive comparison', () => {
    const r = compareRealtimeEvidence(input);
    expect(r.prices.contemporaneousConsolidatedVsIex.absolute).toBe(1);
    expect(r.prices.UNALIGNED_SNAPSHOT_DIFFERENCE).toMatchObject({ absolute: 3, ageDeltaMs: 869000 });
    expect(r.prices.massiveVsTiingoAlignedMinute).toMatchObject({ massiveSnapshotPrice: 100, tiingoMinuteClose: 100.2,
      tiingoMinuteTimestamp: t(31), alignmentStatus: 'EXACT_MINUTE', absolute: .2 });
    expect(r.providers.tiingoConsolidated).toMatchObject({ observationAgeMs: 0, clockSkewMs: 1000 });
    expect(r.startedAt).toBe(startedAt.toISOString()); expect(r.completedAt).toBe(completedAt.toISOString());
  });
  it('limits gap and distribution metrics to the common interval and splits NY sessions', () => {
    const r = compareRealtimeEvidence(input);
    expect(r.minutes.overlapWindow).toEqual({ start: t(30), end: t(31) });
    expect(r.minutes).toMatchObject({ alignedCount: 2, massiveOnlyCount: 0, tiingoOnlyCount: 0,
      closeAbsolute: { median: .15, max: .2 }, volumeRatio: { median: 1.1 } });
    expect(r.minutes.missingInMassive).toEqual([]);
    expect(r.minutes.coverage.tiingo.REGULAR).toBe(4);
    expect(sessionSegment('2026-09-24T07:59:00Z')).toBe('OVERNIGHT');
    expect(sessionSegment('2026-09-24T12:00:00Z')).toBe('PREMARKET');
    expect(sessionSegment('2026-09-24T20:30:00Z')).toBe('POSTMARKET');
  });
  it('counts a real internal provider-only minute while excluding the newer delayed tail', () => {
    if (!input.massive.ok) throw new Error('Invalid fixture');
    const r = compareRealtimeEvidence({ ...input, massive: { ...input.massive,
      value: { ...input.massive.value, minuteBars: [minute(30, 99, 10), minute(32, 101, 20)] } } });
    expect(r.minutes.overlapWindow).toEqual({ start: t(30), end: t(32) });
    expect(r.minutes.missingInMassive).toEqual([t(31)]);
    expect(r.minutes.providerOnlyBySegment.tiingo.REGULAR).toBe(1);
    expect(r.minutes.missingInMassive).not.toContain(t(45));
  });
  it('excludes prior New York sessions from day-volume and VWAP diagnostics', () => {
    if (!input.massive.ok) throw new Error('Invalid fixture');
    const prior = { ...minute(30, 1, 5000), time: '2026-09-23T19:30:00.000Z' };
    const r = compareRealtimeEvidence({ ...input, massive: { ...input.massive,
      value: { ...input.massive.value, minuteBars: [prior, ...input.massive.value.minuteBars] } } });
    expect(r.volumeDiagnostics.massiveMinuteSumThroughMassiveCutoff).toBe(30);
    expect(r.minutes.coverage.massive.REGULAR).toBe(2);
    expect(r.sessionDate).toBe('2026-09-24');
  });
  it('reports bounded volume diagnostics and exploratory VWAP without newer Tiingo bars', () => {
    const r = compareRealtimeEvidence(input);
    expect(r.volumeDiagnostics).toMatchObject({ cutoff: t(31), tiingoMinuteSumThroughMassiveCutoff: 33,
      massiveMinuteSumThroughMassiveCutoff: 30, sharedTiingoMinuteSum: 33, sharedMassiveMinuteSum: 30 });
    expect(r.snapshotSemantics.dayVolume).toMatchObject({ values: { MASSIVE: 1000, TIINGO_CONSOLIDATED: 90, TIINGO_IEX: null },
      semanticEquivalence: 'UNVERIFIED' });
    expect(r.vwap).toMatchObject({ tiingoDocumentedVwap: 'UNAVAILABLE', interval: { start: t(30), end: t(31) },
      exploratoryMetric: 'EXPLORATORY_MINUTE_TYPICAL_PRICE_VWAP' });
    expect(r.vwap.extendedInclusive).toBeCloseTo((99.1 * 11 + 100.2 * 22) / 33, 8);
    const summary = summarizeComparisons([r]);
    expect(summary.distributions.consolidatedVsIexAbsolute).toMatchObject({ count: 1, median: 1 });
    expect(JSON.stringify(summary)).not.toContain('alignedDifferences');
  });
  it('fails alignment closed and isolates provider failures', () => {
    if (!input.massive.ok) throw new Error('Invalid fixture');
    const r = compareRealtimeEvidence({ ...input,
      massive: { ...input.massive, value: { ...input.massive.value, snapshot: { ...input.massive.value.snapshot, updatedTime: t(29) } } },
      iex: { ok: false, error: 'HTTP_429', fetchedAt: completedAt } });
    expect(r.prices.massiveVsTiingoAlignedMinute.alignmentStatus).toBe('EXACT_MINUTE_UNAVAILABLE');
    expect(r.prices.contemporaneousConsolidatedVsIex.absolute).toBeNull();
    expect(r.providers.tiingoIex).toEqual({ ok: false, error: 'HTTP_429', fetchedAt: completedAt.toISOString() });
  });
  it('keeps production consumers Massive-backed and the command DB-free', () => {
    const facade = readFileSync('src/services/live-market-data.service.ts', 'utf8');
    expect(facade).toContain("PRODUCTION_REALTIME_AUTHORITY = 'MASSIVE'"); expect(facade).not.toMatch(/tiingo|TIINGO/);
    for (const file of ['momentum-price-confirmation.service.ts', 'momentum-market-chart.service.ts',
      'account-subscription-market-context.service.ts', 'account-subscription-runtime-sizing.service.ts', 'trading-account-risk-health.service.ts']) {
      expect(readFileSync(`src/services/${file}`, 'utf8')).toContain("from './live-market-data.service.js'");
    }
    expect(readFileSync('scripts/compare-realtime-market-data.ts', 'utf8')).not.toMatch(/db\/prisma|\.create\(|\.update\(|\.upsert\(/);
  });
});
