/** Manual, read-only dashboard market-state acceptance. Never imported by startup. */
import { dashboardReferenceValue, getDashboardMarketState, type DashboardMarketState } from '../services/dashboard-market-state.service.js';

export const DASHBOARD_MARKET_STATE_PHASES = ['PREMARKET', 'AFTER_OPEN', 'MIDDAY', 'NEAR_CLOSE', 'POSTMARKET', 'CLOSED'] as const;
export type DashboardMarketStatePhase = typeof DASHBOARD_MARKET_STATE_PHASES[number];

export async function captureDashboardMarketStateAcceptance(phase: DashboardMarketStatePhase,
  getState: () => Promise<DashboardMarketState> = () => getDashboardMarketState(), now = () => new Date()) {
  const startedAt = now().toISOString();
  const state = await getState();
  const symbols = state.symbols.map(row => ({
    symbol: row.symbol, latestPrice: dashboardReferenceValue(row.referencePrice),
    priceBasis: row.referencePrice.basis, priceProvider: row.referencePrice.provider,
    observedAt: row.referencePrice.observedAt, freshness: row.referencePrice.freshness,
    priceUnavailableReason: row.referencePrice.unavailableReason, providerError: row.referencePrice.providerError,
    observationPhase: row.observationPhase,
    baselineClose: row.previousClose.close, baselineSessionDate: row.previousClose.sessionDate,
    baselineSource: row.previousClose.source, baselineReason: row.previousClose.reason,
    regularSessionDate: row.regularSession?.sessionDate ?? null,
    regularState: row.regularSession?.state ?? 'UNAVAILABLE',
    regularHigh: row.regularSession?.high ?? null, regularLow: row.regularSession?.low ?? null,
    regularClose: row.regularSession?.close ?? null, observedThrough: row.regularSession?.observedThrough ?? null,
    regularSource: row.regularSession?.source ?? null, regularReason: row.regularSession?.reason ?? null,
    change: row.change, changePercent: row.changePercent, changeReason: row.changeReason,
    rangePosition: row.rangePosition, rangeReason: row.rangeReason,
    splitCompatibility: row.splitCompatibility,
  }));
  const count = (predicate: (row: typeof symbols[number]) => boolean) => symbols.filter(predicate).length;
  return { schemaVersion: 1, researchOnly: true, phase, startedAt, completedAt: now().toISOString(),
    marketStateUpdatedAt: state.updatedAt, symbols,
    summary: { priceCount: count(row => row.latestPrice !== null), baselineCount: count(row => row.baselineClose !== null),
      changeCount: count(row => row.changePercent !== null), regularRangeCount: count(row => row.rangePosition !== null),
      splitBoundaryCount: count(row => row.splitCompatibility.status === 'SPLIT_BOUNDARY'),
      splitUnresolvedCount: count(row => row.splitCompatibility.status === 'UNRESOLVED'),
      partialCount: count(row => row.regularState === 'PARTIAL'), completeCount: count(row => row.regularState === 'COMPLETE') } };
}

export function formatDashboardMarketStateAcceptance(report: Awaited<ReturnType<typeof captureDashboardMarketStateAcceptance>>) {
  const lines = [`# Tiingo ETF dashboard market-state acceptance — ${report.phase}`, '',
    `Captured: ${report.startedAt} to ${report.completedAt}`, `Market state updated: ${report.marketStateUpdatedAt}`,
    `Prices ${report.summary.priceCount}/4 · baselines ${report.summary.baselineCount}/4 · changes ${report.summary.changeCount}/4 · ranges ${report.summary.regularRangeCount}/4`,
    `Split boundaries ${report.summary.splitBoundaryCount} · unresolved split evidence ${report.summary.splitUnresolvedCount} · partial sessions ${report.summary.partialCount} · complete sessions ${report.summary.completeCount}`, '',
    '| Symbol | Price / basis / observed | Phase | Baseline session / close | Regular session / state / high / low / close / through | Change / % | Range % | Split | Reasons |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.symbols.map(row => `| ${row.symbol} | ${row.latestPrice ?? '—'} / ${row.priceBasis ?? '—'} / ${row.observedAt ?? '—'} (${row.freshness}) | ${row.observationPhase} | ${row.baselineSessionDate ?? '—'} / ${row.baselineClose ?? '—'} | ${row.regularSessionDate ?? '—'} / ${row.regularState} / ${row.regularHigh ?? '—'} / ${row.regularLow ?? '—'} / ${row.regularClose ?? '—'} / ${row.observedThrough ?? '—'} | ${row.change ?? '—'} / ${row.changePercent ?? '—'} | ${row.rangePosition ?? '—'} | ${row.splitCompatibility.status}${row.splitCompatibility.executionDates.length ? ` (${row.splitCompatibility.executionDates.join(', ')})` : ''} | ${[row.priceUnavailableReason, row.baselineReason, row.regularReason, row.changeReason, row.rangeReason].filter(Boolean).join(', ') || '—'} |`),
    '', 'The phase label is operator metadata. The observation phase comes from the price timestamp and reviewed New York calendar.',
    'Regular range uses regular minute close, never the extended-hours reference price.', ''];
  return lines.join('\n');
}
