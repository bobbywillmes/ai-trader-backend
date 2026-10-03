import { describe, expect, it, vi } from 'vitest';
import type { TiingoBar } from '../integrations/tiingo/rest.client.js';
import { etInstant, marketSession, type CalendarException } from './market-calendar.js';
import { dashboardReferenceValue, getDashboardMarketState, summarizeRegularMinutes } from './dashboard-market-state.service.js';
import type { CapabilityProvider, ReferencePriceEvidence } from './live-market-data.contracts.js';

const friday = '2026-10-02'; const monday = '2026-10-05';
const observation = (at: string, symbol = 'SPY', price = 105, stale = false): ReferencePriceEvidence => ({
  symbol, provider: 'TIINGO_CONSOLIDATED', price, basis: 'TIINGO_TNGO_LAST', observedAt: at,
  fetchedAt: new Date(Date.parse(at) + (stale ? 10 * 60_000 : 1000)).toISOString(),
  freshness: stale ? 'STALE' : 'FRESH', available: !stale,
  unavailableReason: stale ? 'STALE_OBSERVATION' : null, providerError: null,
});
function bars(date: string, close: number, exceptions: CalendarException[] = []): TiingoBar[] {
  const session = marketSession(date, exceptions)!;
  const count = (session.closeAt.getTime() - session.openAt.getTime()) / 60_000;
  return Array.from({ length: count }, (_, index) => ({
    barStartAt: new Date(session.openAt.getTime() + index * 60_000),
    open: close, high: close + 1, low: close - 1, close, volume: 100,
  }));
}
function scenario(at: string, options: { exceptions?: CalendarException[]; missing?: string; badSymbol?: string; previous?: boolean;
  current?: boolean; stale?: boolean; close?: number } = {}) {
  const exceptions = options.exceptions ?? [];
  const requested: string[] = [];
  const verify = vi.fn(async (symbol: string, _provider: CapabilityProvider) => observation(at, symbol, 105, options.stale));
  const minutes = vi.fn(async (symbol: string, date: string) => {
    requested.push(`${symbol}:${date}`);
    if (symbol === options.badSymbol) throw new Error('provider failure');
    if (date === options.missing) return bars(date, date === friday ? 100 : 102, exceptions).slice(0, -1);
    if (date === friday && options.previous === false || date === monday && options.current === false) return [];
    return bars(date, date === friday ? 100 : options.close ?? 102, exceptions);
  });
  return { requested, verify, minutes, calendar: async () => exceptions };
}

describe('Tiingo dashboard market state', () => {
  it.each([
    ['Monday premarket', '2026-10-05T12:00:00Z', '2026-10-05T12:15:00Z', 'PREMARKET', friday],
    ['Monday regular', '2026-10-05T14:00:00Z', '2026-10-05T14:15:00Z', 'REGULAR', friday],
    ['Monday postmarket', '2026-10-05T21:00:00Z', '2026-10-05T21:15:00Z', 'POSTMARKET', monday],
    ['Saturday latest-known Friday', '2026-10-02T23:59:00Z', '2026-10-03T16:00:00Z', 'POSTMARKET', friday],
  ] as const)('%s selects the proper regular close', async (_label, at, viewedAt, phase, baselineDate) => {
    const deps = scenario(at, { stale: true });
    const result = await getDashboardMarketState(new Date(viewedAt), deps);
    const spy = result.symbols[0]!;
    expect(spy.observationPhase).toBe(phase);
    expect(spy.previousClose).toMatchObject({ sessionDate: baselineDate, close: baselineDate === friday ? 100 : 102 });
    expect(spy.change).toBe(baselineDate === friday ? 5 : 3);
    expect(spy.changePercent).toBeCloseTo(baselineDate === friday ? 5 : (105 / 102 - 1) * 100);
    expect(dashboardReferenceValue(spy.referencePrice)).toBe(105);
    expect(deps.verify.mock.calls.every(call => call[1] === 'TIINGO_CONSOLIDATED')).toBe(true);
  });

  it('skips a reviewed holiday to the previous completed session', async () => {
    const deps = scenario('2026-10-06T12:00:00Z', { exceptions: [{ sessionDate: monday, type: 'CLOSED', closeTimeMinutesEt: null }] });
    const spy = (await getDashboardMarketState(new Date('2026-10-06T12:01:00Z'), deps)).symbols[0]!;
    expect(spy.previousClose).toMatchObject({ sessionDate: friday, close: 100 });
    expect(deps.requested).toContain('SPY:2026-10-02');
    expect(deps.requested).not.toContain('SPY:2026-10-05');
  });

  it('uses the verified final minute on an early close without EOD evidence', async () => {
    const exceptions: CalendarException[] = [{ sessionDate: friday, type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }];
    const deps = scenario('2026-10-02T18:00:00Z', { exceptions });
    const spy = (await getDashboardMarketState(new Date('2026-10-02T18:01:00Z'), deps)).symbols[0]!;
    expect(spy.observationPhase).toBe('POSTMARKET');
    expect(spy.previousClose).toMatchObject({ sessionDate: friday, close: 100, source: 'TIINGO_REGULAR_MINUTE' });
    expect(spy.regularSession).toMatchObject({ state: 'COMPLETE', sessionDate: friday });
  });

  it('treats current-session high/low as partial and uses its own regular close for range', async () => {
    const deps = scenario('2026-10-05T14:00:00Z');
    const spy = (await getDashboardMarketState(new Date('2026-10-05T14:01:00Z'), deps)).symbols[0]!;
    expect(spy.regularSession).toMatchObject({ state: 'PARTIAL', high: 103, low: 101, close: 102 });
    expect(spy.rangePosition).toBe(50);
    expect(spy.referencePrice.price).toBe(105);
    expect(spy.rangePosition).not.toBe(100);
  });

  it('rejects a missing final minute for the completed baseline and keeps the price', async () => {
    const deps = scenario('2026-10-02T23:59:00Z', { missing: friday });
    const spy = (await getDashboardMarketState(new Date('2026-10-03T00:00:00Z'), deps)).symbols[0]!;
    expect(spy.previousClose.close).toBeNull();
    expect(spy.change).toBeNull();
    expect(spy.regularSession).toMatchObject({ state: 'UNAVAILABLE', reason: 'INCOMPLETE_MINUTES' });
    expect(spy.rangePosition).toBeNull();
    expect(spy.referencePrice.price).toBe(105);
  });

  it('suppresses only range when current-session bars are missing', async () => {
    const deps = scenario('2026-10-05T14:00:00Z', { current: false });
    const spy = (await getDashboardMarketState(new Date('2026-10-05T14:01:00Z'), deps)).symbols[0]!;
    expect(spy.previousClose.close).toBe(100);
    expect(spy.change).toBe(5);
    expect(spy.rangePosition).toBeNull();
  });

  it('isolates one symbol provider failure and never requests Massive or snapshot previousClose', async () => {
    const deps = scenario('2026-10-05T14:00:00Z', { badSymbol: 'QQQ' });
    const result = await getDashboardMarketState(new Date('2026-10-05T14:01:00Z'), deps);
    expect(result.symbols.map(row => row.change)).toEqual([5, null, 5, 5]);
    expect(result.symbols.map(row => row.referencePrice.provider)).toEqual(Array(4).fill('TIINGO_CONSOLIDATED'));
    expect(deps.minutes.mock.calls.every(call => ['2026-10-02', '2026-10-05'].includes(call[1]))).toBe(true);
  });

  it('keeps three symbols when one normalized reference request fails', async () => {
    const deps = scenario('2026-10-05T14:00:00Z');
    const verify = async (symbol: string) => {
      if (symbol === 'QQQ') throw new Error('upstream request failed');
      return observation('2026-10-05T14:00:00Z', symbol);
    };
    const result = await getDashboardMarketState(new Date('2026-10-05T14:01:00Z'), { ...deps, verify });
    expect(result.symbols.map(row => row.change)).toEqual([5, null, 5, 5]);
    expect(result.symbols[1]?.referencePrice).toMatchObject({ provider: 'TIINGO_CONSOLIDATED', price: null, unavailableReason: 'PROVIDER_ERROR' });
    expect(deps.requested.some(item => item.startsWith('QQQ:'))).toBe(false);
  });

  it('requires a strict complete grid, including an early-close final minute', () => {
    const exceptions: CalendarException[] = [{ sessionDate: friday, type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }];
    const full = bars(friday, 100, exceptions);
    expect(summarizeRegularMinutes(friday, full, exceptions, etInstant(friday, 780), true)).toMatchObject({ state: 'COMPLETE', close: 100 });
    expect(summarizeRegularMinutes(friday, full.slice(0, -1), exceptions, etInstant(friday, 780), true)).toMatchObject({ state: 'UNAVAILABLE', reason: 'INCOMPLETE_MINUTES' });
  });

  it('accepts a lagging but contiguous partial session and records its last minute', () => {
    const partial = bars(monday, 102).slice(0, 20);
    const summary = summarizeRegularMinutes(monday, partial, [], etInstant(monday, 610), false);
    expect(summary).toMatchObject({ state: 'PARTIAL', close: 102, observedThrough: partial.at(-1)!.barStartAt.toISOString() });
    expect(summarizeRegularMinutes(monday, partial.slice(1), [], etInstant(monday, 610), false))
      .toMatchObject({ state: 'UNAVAILABLE', reason: 'INCOMPLETE_MINUTES' });
  });

  it('does not accept a future or malformed reference observation', () => {
    expect(dashboardReferenceValue({ ...observation('2026-10-02T19:00:00Z'), freshness: 'FUTURE', available: false, unavailableReason: 'FUTURE_TIMESTAMP' })).toBeNull();
    expect(dashboardReferenceValue({ ...observation('2026-10-02T19:00:00Z'), price: 0 })).toBeNull();
  });
});
