/** Manual research only. Never imported by startup or trading consumers. */
import { verifyReferencePrice } from '../services/live-market-data.service.js';
import type { CapabilityProvider, ReferencePriceEvidence } from '../services/live-market-data.contracts.js';
import { evaluateTradingReferencePrice, tradingPricePhase } from '../services/trading-reference-price.policy.js';
import type { CalendarException } from '../services/market-calendar.js';

export const TRADING_PRICE_CAPTURE_PHASES = ['PREMARKET', 'AFTER_OPEN', 'MIDDAY', 'NEAR_CLOSE', 'POSTMARKET', 'CLOSED'] as const;
export type TradingPriceCapturePhase = typeof TRADING_PRICE_CAPTURE_PHASES[number];
type Verify = (symbol: string, provider: CapabilityProvider) => Promise<ReferencePriceEvidence>;
const alignedWithinMs = 30_000;
const safe = async (symbol: string, provider: CapabilityProvider, verify: Verify, now: () => Date) => {
  try { return await verify(symbol, provider); }
  catch { return { symbol, provider, price: null, basis: null, observedAt: null, fetchedAt: now().toISOString(),
    freshness: 'UNKNOWN', available: false, unavailableReason: 'PROVIDER_ERROR', providerError: 'REQUEST_FAILED' } as ReferencePriceEvidence; }
};
function observedAge(row: ReferencePriceEvidence, evaluatedAt: Date) {
  const observed = row.observedAt === null ? NaN : Date.parse(row.observedAt);
  return Number.isFinite(observed) ? evaluatedAt.getTime() - observed : null;
}
export async function captureTradingReferencePrices(symbols: readonly string[], phase: TradingPriceCapturePhase,
  exceptions: readonly CalendarException[], verify: Verify = verifyReferencePrice, now = () => new Date()) {
  if (symbols.length < 1 || symbols.length > 20 || new Set(symbols).size !== symbols.length)
    throw new Error('Pass 1-20 distinct symbols.');
  const startedAt = now().toISOString();
  const rows: Array<{ symbol: string; evaluatedAt: string;
    massive: ReferencePriceEvidence & { ageMs: number | null };
    tiingo: ReferencePriceEvidence & { ageMs: number | null; tradingPolicy: ReturnType<typeof evaluateTradingReferencePrice> };
    comparison: { alignment: 'TIMESTAMPS_WITHIN_30_SECONDS' | 'UNALIGNED'; observationTimeDeltaMs: number | null;
      absoluteDifference: number | null; basisPointDifference: number | null } }> = [];
  for (let i = 0; i < symbols.length; i += 4) {
    rows.push(...await Promise.all(symbols.slice(i, i + 4).map(async symbol => {
      const [massive, tiingo] = await Promise.all([
        safe(symbol, 'MASSIVE', verify, now), safe(symbol, 'TIINGO_CONSOLIDATED', verify, now),
      ]);
      const evaluatedAt = now();
      const policy = evaluateTradingReferencePrice(symbol, tiingo, evaluatedAt, exceptions);
      const massiveAgeMs = observedAge(massive, evaluatedAt);
      const tiingoAgeMs = observedAge(tiingo, evaluatedAt);
      const timeDeltaMs = massive.observedAt && tiingo.observedAt
        ? Date.parse(tiingo.observedAt) - Date.parse(massive.observedAt) : NaN;
      const pricePair = typeof massive.price === 'number' && massive.price > 0 &&
        typeof tiingo.price === 'number' && tiingo.price > 0;
      const difference = pricePair ? tiingo.price! - massive.price! : null;
      const aligned = pricePair && Number.isFinite(timeDeltaMs) && Math.abs(timeDeltaMs) <= alignedWithinMs;
      return { symbol, evaluatedAt: evaluatedAt.toISOString(),
        massive: { ...massive, ageMs: massiveAgeMs },
        tiingo: { ...tiingo, ageMs: tiingoAgeMs, tradingPolicy: policy },
        comparison: { alignment: aligned ? 'TIMESTAMPS_WITHIN_30_SECONDS' as const : 'UNALIGNED' as const,
          observationTimeDeltaMs: Number.isFinite(timeDeltaMs) ? timeDeltaMs : null,
          absoluteDifference: difference === null ? null : Math.abs(difference),
          basisPointDifference: aligned ? difference! / massive.price! * 10_000 : null } };
    })));
  }
  const basisCounts = Object.fromEntries(['TIINGO_TNGO_LAST', 'TIINGO_LQ_REF_PRICE', 'NONE'].map(basis =>
    [basis, rows.filter(row => (row.tiingo.basis ?? 'NONE') === basis).length]));
  const rejectionReasons = Object.fromEntries([...new Set(rows.map(row => row.tiingo.tradingPolicy.rejectionReason).filter((reason): reason is NonNullable<typeof reason> => reason !== null))]
    .map(reason => [reason, rows.filter(row => row.tiingo.tradingPolicy.rejectionReason === reason).length]));
  return { schemaVersion: 1, researchOnly: true, productionAuthority: 'MASSIVE' as const,
    operatorPhase: phase, actualSessionPhase: tradingPricePhase(new Date(startedAt), exceptions),
    startedAt, completedAt: now().toISOString(), symbols: rows,
    summary: { symbolCount: rows.length, tiingoNormalizedAvailableCount: rows.filter(row => row.tiingo.available).length,
      tiingoTradingUsableCount: rows.filter(row => row.tiingo.tradingPolicy.usable).length,
      basisCounts, rejectionReasons, alignedComparisonCount: rows.filter(row => row.comparison.alignment === 'TIMESTAMPS_WITHIN_30_SECONDS').length } };
}

export function formatTradingReferencePriceAcceptance(report: Awaited<ReturnType<typeof captureTradingReferencePrices>>) {
  return [`# Trading reference-price acceptance: ${report.operatorPhase}`, '',
    `Captured: ${report.startedAt} to ${report.completedAt}`,
    `Actual session phase: ${report.actualSessionPhase}`,
    `Tiingo trading-usable: ${report.summary.tiingoTradingUsableCount}/${report.summary.symbolCount}`,
    `Tiingo bases: ${Object.entries(report.summary.basisCounts).map(([basis, count]) => `${basis}=${count}`).join(', ')}`,
    `Rejections: ${Object.entries(report.summary.rejectionReasons).map(([reason, count]) => `${reason}=${count}`).join(', ') || 'none'}`,
    `Aligned comparisons: ${report.summary.alignedComparisonCount}`, '',
    '| Symbol | Massive price / basis / age ms | Tiingo price / basis / age ms | Tiingo usable | Reason | Difference | Aligned bp |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.symbols.map(row => `| ${row.symbol} | ${row.massive.price ?? '—'} / ${row.massive.basis ?? '—'} / ${row.massive.ageMs ?? '—'} | ${row.tiingo.price ?? '—'} / ${row.tiingo.basis ?? '—'} / ${row.tiingo.ageMs ?? '—'} | ${row.tiingo.tradingPolicy.usable} | ${row.tiingo.tradingPolicy.rejectionReason ?? '—'} | ${row.comparison.absoluteDifference ?? '—'} | ${row.comparison.basisPointDifference?.toFixed(2) ?? '—'} |`),
    '', 'Massive is comparison evidence only. An absolute difference with unaligned timestamps is diagnostic; basis points require timestamps within 30 seconds.', ''].join('\n');
}
