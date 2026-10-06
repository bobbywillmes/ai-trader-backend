import { describe, expect, it } from 'vitest';
import { captureDashboardMarketStateAcceptance, formatDashboardMarketStateAcceptance } from './dashboard-market-state-acceptance.js';
import type { DashboardMarketState } from '../services/dashboard-market-state.service.js';

const reference = (symbol: 'SPY' | 'QQQ' | 'DIA' | 'IWM') => ({ symbol, provider: 'TIINGO_CONSOLIDATED' as const,
  price: 100, basis: 'TIINGO_TNGO_LAST' as const, observedAt: '2026-10-02T23:59:00Z',
  fetchedAt: '2026-10-03T15:00:00Z', freshness: 'STALE' as const, available: false,
  unavailableReason: 'STALE_OBSERVATION' as const, providerError: null });

describe('manual dashboard market-state report', () => {
  it('aggregates independent symbol evidence and retains split reasons', async () => {
    const state: DashboardMarketState = { updatedAt: '2026-10-03T15:00:00Z', symbols: (['SPY', 'QQQ', 'DIA', 'IWM'] as const).map(symbol => ({
      symbol, referencePrice: reference(symbol), observationPhase: 'POSTMARKET',
      previousClose: { sessionDate: symbol === 'QQQ' ? '2026-10-01' : '2026-10-02', close: 99, source: 'TIINGO_REGULAR_MINUTE', reason: null },
      regularSession: { sessionDate: '2026-10-02', state: 'COMPLETE', high: 101, low: 98, close: 99,
        observedThrough: '2026-10-02T19:59:00Z', reason: null, source: 'TIINGO_REGULAR_MINUTE' },
      splitCompatibility: { status: symbol === 'QQQ' ? 'SPLIT_BOUNDARY' : 'SAME_SESSION',
        fromSession: symbol === 'QQQ' ? '2026-10-01' : '2026-10-02', throughSession: '2026-10-02', eventIds: symbol === 'QQQ' ? ['split:1'] : [],
        executionDates: symbol === 'QQQ' ? ['2026-10-02'] : [], reason: symbol === 'QQQ' ? 'SPLIT_BOUNDARY' : null },
      change: symbol === 'QQQ' ? null : 1, changePercent: symbol === 'QQQ' ? null : 100 / 99 - 1,
      changeReason: symbol === 'QQQ' ? 'SPLIT_BOUNDARY' : null, rangePosition: 33.333,
      rangeReason: null,
    })) };
    const report = await captureDashboardMarketStateAcceptance('CLOSED', async () => state,
      () => new Date('2026-10-03T15:00:00Z'));
    expect(report.summary).toMatchObject({ priceCount: 4, baselineCount: 4, changeCount: 3,
      regularRangeCount: 4, splitBoundaryCount: 1, completeCount: 4 });
    expect(report.symbols[1]).toMatchObject({ symbol: 'QQQ', latestPrice: 100, change: null,
      changeReason: 'SPLIT_BOUNDARY', splitCompatibility: { status: 'SPLIT_BOUNDARY' } });
    const markdown = formatDashboardMarketStateAcceptance(report);
    expect(markdown).toContain('Tiingo ETF dashboard market-state acceptance — CLOSED');
    expect(markdown).toContain('QQQ');
    expect(markdown).toContain('SPLIT_BOUNDARY');
    expect(markdown).toContain('2026-10-02T19:59:00Z');
  });
});
