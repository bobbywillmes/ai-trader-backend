import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareRealtimeEvidence } from './realtime-market-data-comparison.js';

const capturedAt = new Date('2026-09-24T14:32:00Z');
const time = '2026-09-24T14:30:00.000Z';
const massive = { ok: true as const, value: { symbol: 'SPY', from: null, to: null, extendedHoursRequested: true,
  snapshot: { symbol: 'SPY', lastPrice: 100, previousClose: 99, intradayHigh: 102, intradayLow: 98,
    dayVolume: 1000, sessionVwap: 100.5, updatedTime: time, observationSource: 'LAST_TRADE' as const },
  minuteBars: [{ time, open: 99, high: 101, low: 99, close: 100, volume: 10, vwap: 100 }],
  rawPayload: { snapshot: null, aggregates: null } } };
const consolidated = { ok: true as const, value: { provider: 'TIINGO_CONSOLIDATED' as const, symbol: 'SPY',
  observedAt: new Date(time), fetchedAt: capturedAt, referencePrice: 100.1, referencePriceSource: 'TNGO_LAST' as const,
  previousClose: 99, open: 99, high: 101, low: 99, volume: 900, extendedHours: true as const } };
const history = { ok: true as const, value: [{ barStartAt: new Date(time), open: 99, high: 101, low: 99, close: 100.2, volume: 12 }] };

describe('read-only realtime comparison', () => {
  it('aligns minutes deterministically and labels derived VWAP as exploratory', () => {
    const result = compareRealtimeEvidence({ symbol: 'SPY', capturedAt, massive, consolidated, history, iex: { ok: false, error: 'IEX unavailable' } });
    expect(result.minutes.alignedCount).toBe(1);
    expect(result.minutes.alignedDifferences).toEqual([{ time, close: 0.2, volume: 2 }]);
    expect(result.latestPriceDifference).toEqual({ absolute: 0.1, basisPoints: 10 });
    expect(result.vwap).toMatchObject({ tiingoDocumentedVwap: 'UNAVAILABLE', exploratoryMetric: 'EXPLORATORY_MINUTE_TYPICAL_PRICE_VWAP' });
    expect(result.providers.tiingoIex).toEqual({ ok: false, error: 'IEX unavailable' });
  });
  it('isolates provider failures without constructing a score or authority choice', () => {
    const result = compareRealtimeEvidence({ symbol: 'SPY', capturedAt, massive: { ok: false, error: 'Massive 503' }, consolidated,
      history: { ok: false, error: 'Tiingo 429' }, iex: { ok: false, error: 'IEX unavailable' } });
    expect(result.minutes.alignedCount).toBe(0);
    expect(result.vwap.exploratoryValue).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/winner|score|token/i);
  });
  it('keeps production consumers behind the Massive-only façade and the command free of DB imports', () => {
    const facade = readFileSync('src/services/live-market-data.service.ts', 'utf8');
    expect(facade).toContain("PRODUCTION_REALTIME_AUTHORITY = 'MASSIVE'");
    expect(facade).not.toMatch(/tiingo|TIINGO/);
    for (const file of ['momentum-price-confirmation.service.ts', 'momentum-market-chart.service.ts',
      'account-subscription-market-context.service.ts', 'account-subscription-runtime-sizing.service.ts', 'trading-account-risk-health.service.ts']) {
      expect(readFileSync(`src/services/${file}`, 'utf8')).toContain("from './live-market-data.service.js'");
    }
    expect(readFileSync('src/controllers/dashboard.controller.ts', 'utf8')).toContain("from '../services/live-market-data.service.js'");
    expect(readFileSync('scripts/compare-realtime-market-data.ts', 'utf8')).not.toMatch(/db\/prisma|\.create\(|\.update\(|\.upsert\(/);
  });
});
