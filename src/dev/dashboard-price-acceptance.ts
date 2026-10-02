/** Manual research only. No database, broker, worker, or production dashboard imports. */
import { verifyReferencePrice } from '../services/live-market-data.service.js';
import type { CapabilityProvider, ReferencePriceEvidence } from '../services/live-market-data.contracts.js';

export const DASHBOARD_PRICE_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM'] as const;
export const DASHBOARD_PRICE_PHASES = ['PREMARKET', 'AFTER_OPEN', 'MIDDAY', 'NEAR_CLOSE', 'POSTMARKET', 'CLOSED'] as const;
export type DashboardPricePhase = typeof DASHBOARD_PRICE_PHASES[number];
type Verify = (symbol: string, provider: CapabilityProvider) => Promise<ReferencePriceEvidence>;

function age(evidence: ReferencePriceEvidence) {
  const delta = evidence.observedAt === null ? NaN : Date.parse(evidence.fetchedAt) - Date.parse(evidence.observedAt);
  return { observationAgeMs: Number.isFinite(delta) ? Math.max(0, delta) : null,
    clockSkewMs: Number.isFinite(delta) && delta < 0 ? -delta : null };
}
function metric(massive: ReferencePriceEvidence, tiingo: ReferencePriceEvidence) {
  const comparable = massive.available && tiingo.available && massive.price !== null && tiingo.price !== null;
  const signed = comparable ? tiingo.price! - massive.price! : null;
  return { comparisonBasis: 'UNALIGNED_REFERENCE_PRICE_DIAGNOSTIC' as const,
    absoluteDifference: signed === null ? null : Math.abs(signed),
    relativeDifference: signed === null || massive.price === 0 ? null : signed / massive.price!,
    basisPoints: signed === null || massive.price === 0 ? null : signed / massive.price! * 10_000,
    observationTimeDeltaMs: massive.observedAt && tiingo.observedAt
      ? Date.parse(tiingo.observedAt) - Date.parse(massive.observedAt) : null };
}

export async function captureDashboardPriceAcceptance(phase: DashboardPricePhase,
  verify: Verify = (symbol, provider) => verifyReferencePrice(symbol, provider), now = () => new Date()) {
  const startedAt = now().toISOString();
  const safeVerify = async (symbol: string, provider: CapabilityProvider): Promise<ReferencePriceEvidence> => {
    try { return await verify(symbol, provider); }
    catch { return { symbol, provider, price: null, basis: null, observedAt: null, fetchedAt: now().toISOString(),
      freshness: 'UNKNOWN', available: false, unavailableReason: 'PROVIDER_ERROR', providerError: 'REQUEST_FAILED' }; }
  };
  const symbols = await Promise.all(DASHBOARD_PRICE_SYMBOLS.map(async symbol => {
    const [massive, tiingo] = await Promise.all([safeVerify(symbol, 'MASSIVE'), safeVerify(symbol, 'TIINGO_CONSOLIDATED')]);
    return { symbol, massive: { ...massive, ...age(massive) }, tiingo: { ...tiingo, ...age(tiingo) },
      comparison: metric(massive, tiingo) };
  }));
  const unavailable = symbols.filter(row => !row.tiingo.available);
  const basisCounts = Object.fromEntries(['TIINGO_TNGO_LAST', 'TIINGO_LQ_REF_PRICE', 'NONE'].map(basis =>
    [basis, symbols.filter(row => (row.tiingo.basis ?? 'NONE') === basis).length]));
  const unavailableReasons = Object.fromEntries([...new Set(unavailable.map(row => row.tiingo.unavailableReason ?? 'UNKNOWN'))].map(reason =>
    [reason, unavailable.filter(row => (row.tiingo.unavailableReason ?? 'UNKNOWN') === reason).length]));
  return { schemaVersion: 1, researchOnly: true, productionAuthority: 'MASSIVE' as const, phase,
    startedAt, completedAt: now().toISOString(), symbols,
    summary: { tiingoAvailableCount: symbols.length - unavailable.length, allFourTiingoAvailable: unavailable.length === 0,
      tiingoUnavailableSymbols: unavailable.map(row => ({ symbol: row.symbol, reason: row.tiingo.unavailableReason,
        providerError: row.tiingo.providerError })), basisCounts, tiingoStaleCount: unavailable.filter(row => row.tiingo.freshness === 'STALE').length,
      tiingoUnavailableCount: unavailable.length, unavailableReasons } };
}

export function formatDashboardPriceAcceptance(report: Awaited<ReturnType<typeof captureDashboardPriceAcceptance>>) {
  const lines = [`# Dashboard ETF reference-price acceptance — ${report.phase}`, '',
    `Captured: ${report.startedAt} to ${report.completedAt}`,
    `Tiingo available: ${report.summary.tiingoAvailableCount}/4; all four: ${report.summary.allFourTiingoAvailable ? 'yes' : 'no'}`,
    `Tiingo bases: ${Object.entries(report.summary.basisCounts).map(([basis, count]) => `${basis}=${count}`).join(', ')}`,
    `Tiingo stale: ${report.summary.tiingoStaleCount}; unavailable: ${report.summary.tiingoUnavailableCount}`,
    `Unavailable reasons: ${Object.entries(report.summary.unavailableReasons).map(([reason, count]) => `${reason}=${count}`).join(', ') || 'none'}`, '',
    '| Symbol | Massive | Tiingo | Tiingo basis | Tiingo age | Tiingo reason | Difference (bp) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.symbols.map(row => `| ${row.symbol} | ${row.massive.available ? row.massive.price : 'unavailable'} | ${row.tiingo.available ? row.tiingo.price : 'unavailable'} | ${row.tiingo.basis ?? '—'} | ${row.tiingo.observationAgeMs ?? '—'} ms | ${row.tiingo.unavailableReason ?? '—'}${row.tiingo.providerError ? ` (${row.tiingo.providerError})` : ''} | ${row.comparison.basisPoints?.toFixed(2) ?? '—'} |`),
    '', 'Differences are unaligned diagnostics and never affect availability or production authority.', ''];
  return lines.join('\n');
}
