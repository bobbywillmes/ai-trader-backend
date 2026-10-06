import type { TickerPriceConfirmationMarketData } from './massive-market-data.service.js';
import type { TiingoBar, TiingoRealtimeSnapshot } from '../integrations/tiingo/rest.client.js';
import { compareVolumeIntensity } from './realtime-volume-intensity-comparison.js';

export type ProviderResult<T> = { ok: true; value: T; fetchedAt: Date } | { ok: false; error: string; fetchedAt: Date };
export type ComparisonInputs = { symbol: string; startedAt: Date; completedAt: Date;
  minimumDollarVolume: number; configuredRecentWindowMinutes: number;
  massive: ProviderResult<TickerPriceConfirmationMarketData>; consolidated: ProviderResult<TiingoRealtimeSnapshot>;
  history: ProviderResult<TiingoBar[]>; iex: ProviderResult<TiingoRealtimeSnapshot> };
type Segment = 'OVERNIGHT' | 'PREMARKET' | 'REGULAR' | 'POSTMARKET';
const segments: Segment[] = ['OVERNIGHT', 'PREMARKET', 'REGULAR', 'POSTMARKET'];
const round = (n: number | null) => n === null || !Number.isFinite(n) ? null : Number(n.toFixed(8));
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const ratio = (a: number | null, b: number | null) => round(a !== null && b !== null && b !== 0 ? a / b : null);
const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nyDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function sessionDate(time: string) {
  const parts = nyDate.formatToParts(new Date(time));
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function sessionSegment(time: string): Segment {
  const parts = nyTime.formatToParts(new Date(time));
  const clock = Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value);
  return clock < 240 || clock >= 1200 ? 'OVERNIGHT' : clock < 570 ? 'PREMARKET' : clock < 960 ? 'REGULAR' : 'POSTMARKET';
}
const countSegments = (times: string[]) => Object.fromEntries(segments.map(segment => [segment, times.filter(t => sessionSegment(t) === segment).length])) as Record<Segment, number>;
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const rank = (sorted.length - 1) * fraction;
  const lo = Math.floor(rank); const hi = Math.ceil(rank);
  return round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo));
}
const distribution = (values: number[]) => ({ count: values.length, median: percentile(values, .5), p95: percentile(values, .95), max: values.length ? round(Math.max(...values)) : null });
function difference(left: number | null, right: number | null) {
  const signed = left !== null && right !== null ? left - right : null;
  return { left, right, absolute: round(signed === null ? null : Math.abs(signed)), relative: ratio(signed, right),
    basisPoints: round(signed !== null && right ? signed / right * 10_000 : null) };
}
function freshness(observedAt: string | null, fetchedAt: Date) {
  const delta = observedAt ? fetchedAt.getTime() - Date.parse(observedAt) : NaN;
  return { observationAgeMs: Number.isFinite(delta) ? Math.max(0, delta) : null,
    clockSkewMs: Number.isFinite(delta) && delta < 0 ? -delta : null };
}
function derivedVwap(bars: TiingoBar[]) {
  const volume = sum(bars.map(b => b.volume));
  return volume > 0 ? round(sum(bars.map(b => (b.high + b.low + b.close) / 3 * b.volume)) / volume) : null;
}
function semanticFields(m: ComparisonInputs['massive'], c: ComparisonInputs['consolidated'], i: ComparisonInputs['iex']) {
  const fields = {
    previousClose: [m.ok ? m.value.snapshot.previousClose : null, c.ok ? c.value.previousClose : null, i.ok ? i.value.previousClose : null],
    dayHigh: [m.ok ? m.value.snapshot.intradayHigh : null, c.ok ? c.value.high : null, i.ok ? i.value.high : null],
    dayLow: [m.ok ? m.value.snapshot.intradayLow : null, c.ok ? c.value.low : null, i.ok ? i.value.low : null],
    dayVolume: [m.ok ? m.value.snapshot.dayVolume : null, c.ok ? c.value.volume : null, i.ok ? i.value.volume : null],
  };
  return Object.fromEntries(Object.entries(fields).map(([field, values]) => { const [massive, consolidated, iex] = values;
    return [field, { values: { MASSIVE: massive, TIINGO_CONSOLIDATED: consolidated, TIINGO_IEX: iex },
      differences: { consolidatedVsMassive: difference(consolidated ?? null, massive ?? null),
        iexVsMassive: difference(iex ?? null, massive ?? null), consolidatedVsIex: difference(consolidated ?? null, iex ?? null) },
      semanticEquivalence: 'UNVERIFIED' }]; }));
}

/** Exact-minute and common-window diagnostics only; no authority or scoring decision. */
export function compareRealtimeEvidence(input: ComparisonInputs) {
  const { symbol, startedAt, completedAt, massive, consolidated, history, iex } = input;
  const currentSession = sessionDate(startedAt.toISOString());
  const mb = massive.ok ? massive.value.minuteBars.filter(b => sessionDate(b.time) === currentSession) : [];
  const tb = history.ok ? history.value.filter(b => sessionDate(b.barStartAt.toISOString()) === currentSession) : [];
  const mm = new Map(mb.map(b => [b.time, b])); const tm = new Map(tb.map(b => [b.barStartAt.toISOString(), b]));
  const mt = [...mm.keys()].sort(); const tt = [...tm.keys()].sort();
  const start = mt.length && tt.length ? [mt[0]!, tt[0]!].sort().at(-1)! : null;
  const end = mt.length && tt.length ? [mt.at(-1)!, tt.at(-1)!].sort()[0]! : null;
  const overlapWindow = start && end && start <= end ? { start, end } : null;
  const within = (t: string) => !!overlapWindow && t >= overlapWindow.start && t <= overlapWindow.end;
  const me = mt.filter(within); const te = tt.filter(within);
  const aligned = me.filter(t => tm.has(t)); const missingInTiingo = me.filter(t => !tm.has(t));
  const missingInMassive = te.filter(t => !mm.has(t));
  const alignedDifferences = aligned.map(time => { const a = mm.get(time)!; const b = tm.get(time)!;
    return { time, segment: sessionSegment(time), close: round(b.close - a.close),
      closeAbsolute: round(Math.abs(b.close - a.close))!, closeBasisPoints: round(Math.abs(b.close - a.close) / a.close * 10_000)!,
      volume: a.volume === null ? null : round(b.volume - a.volume), volumeRatio: ratio(b.volume, a.volume),
      massiveVolume: a.volume, tiingoVolume: b.volume }; });
  const massivePrice = massive.ok ? massive.value.snapshot.lastPrice : null;
  const massiveObservedAt = massive.ok ? massive.value.snapshot.updatedTime : null;
  const cp = consolidated.ok ? consolidated.value.referencePrice : null; const ip = iex.ok ? iex.value.referencePrice : null;
  const minute = massiveObservedAt && Number.isFinite(Date.parse(massiveObservedAt))
    ? new Date(Math.floor(Date.parse(massiveObservedAt) / 60_000) * 60_000).toISOString() : null;
  const alignedBar = minute ? tm.get(minute) : null;
  // Require an actual minute from both providers at the comparison cutoff.
  const cutoff = aligned.at(-1) ?? null;
  const tiingoThroughCutoff = cutoff ? tb.filter(b => b.barStartAt.toISOString() <= cutoff) : [];
  const massiveThroughCutoff = cutoff ? mb.filter(b => b.time <= cutoff) : [];
  const volumeRows = alignedDifferences.filter(r => r.massiveVolume !== null);
  const tiingoSharedSum = sum(volumeRows.map(r => r.tiingoVolume));
  const massiveSharedSum = sum(volumeRows.map(r => r.massiveVolume!));
  const tiingoCutoffSum = sum(tiingoThroughCutoff.map(b => b.volume));
  const massiveCutoffSum = sum(massiveThroughCutoff.map(b => b.volume ?? 0));
  const mv = massive.ok ? massive.value.snapshot.sessionVwap : null;
  const vwapBars = tiingoThroughCutoff.filter(b => !!overlapWindow && b.barStartAt.toISOString() >= overlapWindow.start);
  const extendedVwap = derivedVwap(vwapBars);
  const regularVwap = derivedVwap(vwapBars.filter(b => sessionSegment(b.barStartAt.toISOString()) === 'REGULAR'));
  return {
    symbol, sessionDate: currentSession, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
    providers: {
      massive: massive.ok ? { ok: true, referencePrice: massivePrice, observedAt: massiveObservedAt, fetchedAt: massive.fetchedAt.toISOString(),
        ...freshness(massiveObservedAt, massive.fetchedAt), previousClose: massive.value.snapshot.previousClose,
        dayHigh: massive.value.snapshot.intradayHigh, dayLow: massive.value.snapshot.intradayLow,
        dayVolume: massive.value.snapshot.dayVolume } : { ok: false, error: massive.error, fetchedAt: massive.fetchedAt.toISOString() },
      tiingoConsolidated: consolidated.ok ? { ok: true, referencePrice: cp, referencePriceSource: consolidated.value.referencePriceSource,
        observedAt: consolidated.value.observedAt?.toISOString() ?? null, fetchedAt: consolidated.value.fetchedAt.toISOString(),
        ...freshness(consolidated.value.observedAt?.toISOString() ?? null, consolidated.value.fetchedAt),
        previousClose: consolidated.value.previousClose, dayHigh: consolidated.value.high, dayLow: consolidated.value.low,
        dayVolume: consolidated.value.volume } : { ok: false, error: consolidated.error, fetchedAt: consolidated.fetchedAt.toISOString() },
      tiingoIex: iex.ok ? { ok: true, referencePrice: ip, observedAt: iex.value.observedAt?.toISOString() ?? null,
        fetchedAt: iex.value.fetchedAt.toISOString(), ...freshness(iex.value.observedAt?.toISOString() ?? null, iex.value.fetchedAt),
        previousClose: iex.value.previousClose, dayHigh: iex.value.high, dayLow: iex.value.low,
        dayVolume: iex.value.volume } : { ok: false, error: iex.error, fetchedAt: iex.fetchedAt.toISOString() },
      tiingoHistory: history.ok ? { ok: true, minuteCount: tb.length, fetchedAt: history.fetchedAt.toISOString() }
        : { ok: false, error: history.error, fetchedAt: history.fetchedAt.toISOString() },
    },
    prices: {
      contemporaneousConsolidatedVsIex: { ...difference(cp, ip), consolidatedObservedAt: consolidated.ok ? consolidated.value.observedAt?.toISOString() ?? null : null,
        iexObservedAt: iex.ok ? iex.value.observedAt?.toISOString() ?? null : null },
      UNALIGNED_SNAPSHOT_DIFFERENCE: { ...difference(cp, massivePrice), consolidatedObservedAt: consolidated.ok ? consolidated.value.observedAt?.toISOString() ?? null : null,
        massiveObservedAt, ageDeltaMs: massiveObservedAt && consolidated.ok && consolidated.value.observedAt
          ? consolidated.value.observedAt.getTime() - Date.parse(massiveObservedAt) : null },
      massiveVsTiingoAlignedMinute: { massiveSnapshotPrice: massivePrice, massiveObservedAt,
        tiingoMinuteClose: alignedBar?.close ?? null, tiingoMinuteTimestamp: alignedBar ? minute : null,
        ...difference(alignedBar?.close ?? null, massivePrice), alignmentStatus: !massiveObservedAt ? 'MASSIVE_TIMESTAMP_UNAVAILABLE'
          : massivePrice === null ? 'MASSIVE_PRICE_UNAVAILABLE' : !alignedBar ? 'EXACT_MINUTE_UNAVAILABLE' : 'EXACT_MINUTE' },
    },
    snapshotSemantics: semanticFields(massive, consolidated, iex),
    minutes: { overlapWindow, latestMassiveMinute: cutoff, latestTiingoMinute: tt.at(-1) ?? null,
      alignedCount: aligned.length, massiveOnlyCount: missingInTiingo.length, tiingoOnlyCount: missingInMassive.length,
      missingInTiingo, missingInMassive, providerOnlyBySegment: { massive: countSegments(missingInTiingo), tiingo: countSegments(missingInMassive) },
      coverage: { massive: countSegments(mt), tiingo: countSegments(tt) },
      closeAbsolute: distribution(alignedDifferences.map(r => r.closeAbsolute)),
      closeBasisPoints: distribution(alignedDifferences.map(r => r.closeBasisPoints)),
      volumeAbsoluteDifference: distribution(alignedDifferences.flatMap(r => r.volume === null ? [] : [Math.abs(r.volume)])),
      volumeRatio: distribution(alignedDifferences.flatMap(r => r.volumeRatio === null ? [] : [r.volumeRatio])), alignedDifferences },
    volumeDiagnostics: { cutoff, tiingoMinuteSumThroughMassiveCutoff: tiingoCutoffSum,
      tiingoSnapshotVolume: consolidated.ok ? consolidated.value.volume : null,
      tiingoMinuteVsSnapshot: difference(tiingoCutoffSum, consolidated.ok ? consolidated.value.volume : null),
      massiveMinuteSumThroughMassiveCutoff: massiveCutoffSum, massiveSnapshotDayVolume: massive.ok ? massive.value.snapshot.dayVolume : null,
      massiveMinuteVsSnapshot: difference(massiveCutoffSum, massive.ok ? massive.value.snapshot.dayVolume : null),
      sharedTimestampCountWithVolume: volumeRows.length, sharedTiingoMinuteSum: tiingoSharedSum,
      sharedMassiveMinuteSum: massiveSharedSum, sharedTiingoVsMassive: difference(tiingoSharedSum, massiveSharedSum) },
    momentumVolumeParity: compareVolumeIntensity({ massive: mb.map(b => ({ time: b.time, volume: b.volume, close: b.close })),
      tiingo: tb.map(b => ({ time: b.barStartAt.toISOString(), volume: b.volume, close: b.close })),
      cutoff, minimumDollarVolume: input.minimumDollarVolume, configuredRecentWindowMinutes: input.configuredRecentWindowMinutes }),
    vwap: { massiveSessionVwap: mv, tiingoDocumentedVwap: 'UNAVAILABLE', exploratoryMetric: 'EXPLORATORY_MINUTE_TYPICAL_PRICE_VWAP',
      interval: overlapWindow, extendedInclusive: extendedVwap, regularOnly: regularVwap,
      extendedMinusMassive: difference(extendedVwap, mv), regularMinusMassive: difference(regularVwap, mv) },
  };
}
export type ComparisonResult = ReturnType<typeof compareRealtimeEvidence>;
export function summarizeComparisons(results: ComparisonResult[]) {
  const values = (select: (r: ComparisonResult) => number | null) => results.flatMap(r => { const n = select(r); return n === null ? [] : [n]; });
  return { schemaVersion: 3, productionAuthority: 'MASSIVE', symbolCount: results.length,
    symbols: results.map(r => ({ symbol: r.symbol, providers: r.providers, prices: r.prices, snapshotSemantics: r.snapshotSemantics,
      minutes: { ...r.minutes, alignedDifferences: undefined }, volumeDiagnostics: r.volumeDiagnostics,
      momentumVolumeParity: r.momentumVolumeParity, vwap: r.vwap })),
    distributions: { consolidatedVsIexAbsolute: distribution(values(r => r.prices.contemporaneousConsolidatedVsIex.absolute)),
      alignedMassiveVsTiingoAbsolute: distribution(values(r => r.prices.massiveVsTiingoAlignedMinute.absolute)),
      minuteCloseAbsoluteMedian: distribution(values(r => r.minutes.closeAbsolute.median)),
      minuteCloseBasisPointsMedian: distribution(values(r => r.minutes.closeBasisPoints.median)),
      sharedMinuteVolumeRatio: distribution(values(r => ratio(r.volumeDiagnostics.sharedTiingoMinuteSum, r.volumeDiagnostics.sharedMassiveMinuteSum))),
      thirtyMinuteAbsoluteIntensityDifference: distribution(values(r => r.momentumVolumeParity.v6ThirtyMinuteParity.absoluteIntensityDifference)),
      thirtyMinuteMassiveIntensity: distribution(values(r => r.momentumVolumeParity.windows['30'].massive.volumeIntensity)),
      thirtyMinuteTiingoIntensity: distribution(values(r => r.momentumVolumeParity.windows['30'].tiingo.volumeIntensity)),
      thirtyMinuteBucketAgreement: agreement(results.map(r => r.momentumVolumeParity.v6ThirtyMinuteParity.sameBucket)),
      thirtyMinutePointAgreement: agreement(results.map(r => r.momentumVolumeParity.v6ThirtyMinuteParity.sameIntensityPoints)),
      liquidityDecisionAgreement: agreement(results.map(r => r.momentumVolumeParity.liquidity.sameLiquidityDecision)),
      regularThirtyMinuteBucketAgreement: agreement(results.map(r => r.momentumVolumeParity.regularSessionVolumeParity.thirtyMinuteParity.sameBucket)),
      regularThirtyMinutePointAgreement: agreement(results.map(r => r.momentumVolumeParity.regularSessionVolumeParity.thirtyMinuteParity.sameIntensityPoints)),
      cumulativeTiingoMassiveRatioByCheckpoint: Object.fromEntries(['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', 'COMMON_CUTOFF'].map(label =>
        [label, distribution(values(r => r.momentumVolumeParity.cumulativeCheckpoints.find(point => point.checkpoint === label)?.tiingoToMassiveRatio ?? null))])),
      regularCumulativeTiingoMassiveRatioByCheckpoint: Object.fromEntries(['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', 'EFFECTIVE_REGULAR_CUTOFF'].map(label =>
        [label, distribution(values(r => r.momentumVolumeParity.regularSessionVolumeParity.cumulativeCheckpoints.find(point => point.checkpoint === label)?.tiingoToMassiveRatio ?? null))])) } };
}
function agreement(values: Array<boolean | null>) {
  const eligible = values.filter((value): value is boolean => value !== null);
  const agreed = eligible.filter(Boolean).length;
  return { eligible: eligible.length, agreed, disagreed: eligible.length - agreed,
    rate: eligible.length ? round(agreed / eligible.length) : null };
}
