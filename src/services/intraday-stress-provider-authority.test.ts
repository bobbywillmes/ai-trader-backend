import { describe, expect, it } from 'vitest';
import { intradayAuthority } from './intraday-stress-provider-authority.js';
import { aggregateTiingoMinuteWindow } from './tiingo-minute-aggregation.js';
import { barEligibility, etInstant, marketSession } from './market-calendar.js';
import type { TiingoBar } from '../integrations/tiingo/rest.client.js';
import { windowsAt, type Source } from '../dev/intraday-providers/compare.js';
import { Versions, restBars } from '../dev/intraday-providers/model.js';
import { sessionPlan } from '../dev/alpaca-iex/session.js';

describe('Phase 7A intraday authority', () => {
  it('uses strict session-date selection with Massive default', () => {
    expect(intradayAuthority('2026-09-23', undefined).provider).toBe('MASSIVE');
    expect(intradayAuthority('2026-09-23', '2026-09-24').provider).toBe('MASSIVE');
    expect(intradayAuthority('2026-09-24', '2026-09-24').provider).toBe('TIINGO');
    expect(intradayAuthority('2026-09-25', '2026-09-24').provider).toBe('TIINGO');
    expect(() => intradayAuthority('2026-09-24', '2026-02-30')).toThrow();
    expect(() => intradayAuthority('2026-09-24', '09/24/2026')).toThrow();
  });
  it('requires 15 exact minutes and aggregates OHLCV at canonical precision', () => {
    const start = etInstant('2026-09-24', 570);
    const minutes: TiingoBar[] = Array.from({ length: 15 }, (_, i) => ({ barStartAt: new Date(start.getTime() + i * 60_000),
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 0.1 }));
    expect(aggregateTiingoMinuteWindow(minutes, start)).toMatchObject({ open: '100.0000000000', high: '115.0000000000',
      low: '99.0000000000', close: '114.5000000000', volume: '1.500000' });
    expect(aggregateTiingoMinuteWindow(minutes.slice(1), start)).toBeNull();
    expect(aggregateTiingoMinuteWindow([...minutes.slice(0, 14), minutes[0]!], start)).toBeNull();
    expect(aggregateTiingoMinuteWindow([...minutes.slice(0, 14), { ...minutes[14]!, barStartAt: new Date(start.getTime() + 14 * 60_000 + 1000) }], start)).toBeNull();
  });
  it('matches the accepted research REST window fixture', () => {
    const plan = sessionPlan('2026-09-22');
    const start = new Date(plan.openAt);
    const rows = Array.from({ length: 15 }, (_, i) => ({ date: new Date(start.getTime() + i * 60_000).toISOString(),
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 0.1 }));
    const observedAt = new Date(start.getTime() + 21 * 60_000).toISOString();
    const versions = new Versions('parity');
    const observations = restBars(rows, 'TIINGO_REST', 'SPY').data.map(d => versions.observe(d,
      { receivedAt: observedAt, requestedAt: observedAt, connectionEpoch: 0, monotonicOffsetMs: 0 }));
    const source: Source = { key: 'TIINGO_REST', product: 'TIINGO_REST', observations, startedAt: plan.openAt,
      end: plan.closeAt, events: [] };
    const research = windowsAt(source, plan, observedAt).find(w => w.symbol === 'SPY')!.values!;
    const production = aggregateTiingoMinuteWindow(rows.map(row => ({ ...row, barStartAt: new Date(row.date) })), start)!;
    expect({ open: Number(production.open), high: Number(production.high), low: Number(production.low),
      close: Number(production.close) }).toEqual({ open: research.open, high: research.high, low: research.low, close: research.close });
    expect(Number(production.volume)).toBeCloseTo(research.volume!, 6);
  });
  it('retains calendar and bar-end plus five-minute eligibility', () => {
    const start = etInstant('2026-09-24', 570);
    expect(barEligibility('MINUTE_15', start, new Date(start.getTime() + 19 * 60_000)).status).toBe('NOT_YET_ELIGIBLE');
    expect(barEligibility('MINUTE_15', start, new Date(start.getTime() + 20 * 60_000)).status).toBe('ELIGIBLE');
    expect(marketSession('2026-09-26')).toBeNull();
    expect(marketSession('2026-09-24', [{ sessionDate: '2026-09-24', type: 'CLOSED', closeTimeMinutesEt: null }])).toBeNull();
    expect(marketSession('2026-09-25', [{ sessionDate: '2026-09-25', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }])?.closeMinutes).toBe(780);
  });
});
