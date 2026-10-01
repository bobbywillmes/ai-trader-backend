import type { TickerPriceConfirmationMarketData } from './massive-market-data.service.js';
import type { TiingoBar, TiingoRealtimeSnapshot } from '../integrations/tiingo/rest.client.js';

type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type ComparisonInputs = {
  symbol: string; capturedAt: Date;
  massive: ProviderResult<TickerPriceConfirmationMarketData>;
  consolidated: ProviderResult<TiingoRealtimeSnapshot>;
  history: ProviderResult<TiingoBar[]>;
  iex: ProviderResult<TiingoRealtimeSnapshot>;
};

const round = (value: number | null) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(8));
const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function coverage(times: string[]) {
  let regular = 0; let extended = 0;
  for (const time of times) {
    const parts = nyTime.formatToParts(new Date(time));
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    const clock = hour * 60 + minute;
    if (clock >= 570 && clock < 960) regular++;
    else if (clock >= 240 && clock < 1200) extended++;
  }
  return { regularMinutes: regular, extendedMinutes: extended };
}

/** Deterministic, token-free comparison. No candidate selection or scoring. */
export function compareRealtimeEvidence(input: ComparisonInputs) {
  const { symbol, capturedAt, massive, consolidated, history, iex } = input;
  const massiveBars = massive.ok ? massive.value.minuteBars : [];
  const tiingoBars = history.ok ? history.value : [];
  const massiveByTime = new Map(massiveBars.map(bar => [bar.time, bar]));
  const tiingoByTime = new Map(tiingoBars.map(bar => [bar.barStartAt.toISOString(), bar]));
  const massiveTimes = [...massiveByTime.keys()].sort();
  const tiingoTimes = [...tiingoByTime.keys()].sort();
  const aligned = massiveTimes.filter(time => tiingoByTime.has(time));
  const missingInTiingo = massiveTimes.filter(time => !tiingoByTime.has(time));
  const missingInMassive = tiingoTimes.filter(time => !massiveByTime.has(time));
  const massivePrice = massive.ok ? massive.value.snapshot.lastPrice : null;
  const tiingoPrice = consolidated.ok ? consolidated.value.referencePrice : null;
  const priceDifference = massivePrice != null && tiingoPrice != null ? tiingoPrice - massivePrice : null;
  const volumeTotal = tiingoBars.reduce((sum, bar) => sum + bar.volume, 0);
  const exploratoryVwap = volumeTotal > 0 ? tiingoBars.reduce((sum, bar) => sum + (bar.high + bar.low + bar.close) / 3 * bar.volume, 0) / volumeTotal : null;
  const massiveVwap = massive.ok ? massive.value.snapshot.sessionVwap : null;
  return {
    symbol, capturedAt: capturedAt.toISOString(),
    providers: {
      massive: massive.ok ? { ok: true, referencePrice: massivePrice, observedAt: massive.value.snapshot.updatedTime,
        observationAgeMs: massive.value.snapshot.updatedTime ? capturedAt.getTime() - Date.parse(massive.value.snapshot.updatedTime) : null,
        previousClose: massive.value.snapshot.previousClose, dayHigh: massive.value.snapshot.intradayHigh,
        dayLow: massive.value.snapshot.intradayLow, dayVolume: massive.value.snapshot.dayVolume } : { ok: false, error: massive.error },
      tiingoConsolidated: consolidated.ok ? { ok: true, referencePrice: tiingoPrice,
        referencePriceSource: consolidated.value.referencePriceSource,
        observedAt: consolidated.value.observedAt?.toISOString() ?? null,
        observationAgeMs: consolidated.value.observedAt ? capturedAt.getTime() - consolidated.value.observedAt.getTime() : null,
        previousClose: consolidated.value.previousClose, dayHigh: consolidated.value.high,
        dayLow: consolidated.value.low, dayVolume: consolidated.value.volume } : { ok: false, error: consolidated.error },
      tiingoIex: iex.ok ? { ok: true, referencePrice: iex.value.referencePrice,
        observedAt: iex.value.observedAt?.toISOString() ?? null,
        observationAgeMs: iex.value.observedAt ? capturedAt.getTime() - iex.value.observedAt.getTime() : null,
        previousClose: iex.value.previousClose, dayHigh: iex.value.high,
        dayLow: iex.value.low, dayVolume: iex.value.volume } : { ok: false, error: iex.error },
      tiingoHistory: history.ok ? { ok: true, minuteCount: tiingoBars.length } : { ok: false, error: history.error },
    },
    latestPriceDifference: { absolute: round(priceDifference == null ? null : Math.abs(priceDifference)),
      basisPoints: round(priceDifference != null && massivePrice ? priceDifference / massivePrice * 10000 : null) },
    minutes: { alignedCount: aligned.length, massiveOnlyCount: missingInTiingo.length,
      tiingoOnlyCount: missingInMassive.length, missingInTiingo, missingInMassive,
      massiveCoverage: coverage(massiveTimes), tiingoCoverage: coverage(tiingoTimes),
      alignedDifferences: aligned.map(time => { const a = massiveByTime.get(time)!; const b = tiingoByTime.get(time)!;
        return { time, close: round(b.close - a.close), volume: a.volume === null ? null : round(b.volume - a.volume) }; }) },
    vwap: { massiveSessionVwap: massiveVwap, tiingoDocumentedVwap: 'UNAVAILABLE',
      exploratoryMetric: 'EXPLORATORY_MINUTE_TYPICAL_PRICE_VWAP', exploratoryValue: round(exploratoryVwap),
      exploratoryMinusMassive: round(exploratoryVwap != null && massiveVwap != null ? exploratoryVwap - massiveVwap : null) },
  };
}
