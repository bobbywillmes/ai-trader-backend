import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeTradingConfig } from './config.service.js';
import {
  evaluateEntrySessionGuard,
  isEntrySessionBlocked,
} from './entry-session-guard.service.js';
import type { NormalizedMarketSessionSnapshot } from '../integrations/alpaca/market-session.adapter.js';

const mocks = vi.hoisted(() => ({
  getAlpacaMarketSessionSnapshot: vi.fn(),
}));

vi.mock('../integrations/alpaca/market-session.adapter.js', () => ({
  getAlpacaMarketSessionSnapshot: mocks.getAlpacaMarketSessionSnapshot,
}));

const baseConfig: RuntimeTradingConfig = {
  tradingEnabled: true,
  paperMode: true,
  killSwitchEnabled: false,
  maxDailyEntryOrders: 5,
  maxDailyEntryNotional: 10_000,
  maxOpenPositions: 5,
  maxTotalOpenNotional: 25_000,
  maxSymbolOpenNotional: 5_000,
  maxSubscriptionOpenNotional: 5_000,
  entrySessionGuardEnabled: true,
  entryStartMinutesAfterOpen: 15,
  entryCutoffMinutesBeforeClose: 30,
  failClosedOnMarketClockError: true,
  reconciliationWorkerEnabled: false,
  reconciliationWorkerIntervalMinutes: 15,
};

function session(
  evaluatedTimestamp: string,
  overrides: Partial<NormalizedMarketSessionSnapshot> = {}
): NormalizedMarketSessionSnapshot {
  return {
    source: 'alpaca',
    brokerTimestamp: evaluatedTimestamp,
    evaluatedTimestamp,
    marketOpen: true,
    tradingDate: evaluatedTimestamp.slice(0, 10),
    sessionOpenAt: '2026-06-18T13:30:00.000Z',
    sessionCloseAt: '2026-06-18T20:00:00.000Z',
    nextOpenAt: '2026-06-19T13:30:00.000Z',
    nextCloseAt: '2026-06-19T20:00:00.000Z',
    fetchedAt: evaluatedTimestamp,
    cache: { clock: 'fresh', calendar: 'fresh' },
    ...overrides,
  };
}

describe('entry session guard evaluator', () => {
  beforeEach(() => {
    mocks.getAlpacaMarketSessionSnapshot.mockReset();
  });

  it('allows without requesting Alpaca when the guard is disabled', async () => {
    const result = await evaluateEntrySessionGuard({
      ...baseConfig,
      entrySessionGuardEnabled: false,
    });

    expect(result.allowed).toBe(true);
    expect(result.details.status).toBe('disabled');
    expect(mocks.getAlpacaMarketSessionSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['pre-market', '2026-06-18T12:00:00.000Z'],
    ['after-hours', '2026-06-18T21:00:00.000Z'],
    ['holiday or weekend', '2026-06-20T16:00:00.000Z'],
  ])('blocks when the market is closed: %s', async (_label, timestamp) => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValue(
      session(timestamp, {
        marketOpen: false,
        sessionOpenAt: null,
        sessionCloseAt: null,
      })
    );

    const result = await evaluateEntrySessionGuard(baseConfig);

    expect(isEntrySessionBlocked(result)).toBe(true);
    expect(result.details.status).toBe('market_closed');
    if (isEntrySessionBlocked(result)) {
      expect(result.details.rule).toBe('market_closed');
      expect(result.statusCode).toBe(409);
    }
  });

  it('blocks one instant before the opening buffer boundary', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValue(
      session('2026-06-18T13:44:59.999Z')
    );

    const result = await evaluateEntrySessionGuard(baseConfig);

    expect(isEntrySessionBlocked(result)).toBe(true);
    expect(result.details.status).toBe('open_buffer');
  });

  it('allows at the exact opening buffer boundary', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValue(
      session('2026-06-18T13:45:00.000Z')
    );

    const result = await evaluateEntrySessionGuard(baseConfig);

    expect(result.allowed).toBe(true);
    expect(result.details.entryAllowedAt).toBe('2026-06-18T13:45:00.000Z');
  });

  it('allows at the regular open when the opening buffer is zero', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValue(
      session('2026-06-18T13:30:00.000Z')
    );

    const result = await evaluateEntrySessionGuard({
      ...baseConfig,
      entryStartMinutesAfterOpen: 0,
    });

    expect(result.allowed).toBe(true);
    expect(result.details.entryAllowedAt).toBe('2026-06-18T13:30:00.000Z');
  });

  it('allows mid-session entries', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValue(
      session('2026-06-18T16:00:00.000Z')
    );

    const result = await evaluateEntrySessionGuard(baseConfig);

    expect(result.allowed).toBe(true);
    expect(result.details.status).toBe('allowed');
  });

  it('allows one instant before the close cutoff and blocks at the cutoff', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValueOnce(
      session('2026-06-18T19:29:59.999Z')
    );
    expect((await evaluateEntrySessionGuard(baseConfig)).allowed).toBe(true);

    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValueOnce(
      session('2026-06-18T19:30:00.000Z')
    );
    const blocked = await evaluateEntrySessionGuard(baseConfig);

    expect(isEntrySessionBlocked(blocked)).toBe(true);
    expect(blocked.details.status).toBe('close_buffer');
  });

  it('disables only the close buffer when the cutoff is null', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValue(
      session('2026-06-18T19:45:00.000Z')
    );

    const result = await evaluateEntrySessionGuard({
      ...baseConfig,
      entryCutoffMinutesBeforeClose: null,
    });

    expect(result.allowed).toBe(true);
    expect(result.details.entryCutoffAt).toBeNull();
  });

  it('uses the regular close as the cutoff when the close buffer is zero', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValueOnce(
      session('2026-06-18T19:59:59.999Z')
    );
    expect(
      (
        await evaluateEntrySessionGuard({
          ...baseConfig,
          entryCutoffMinutesBeforeClose: 0,
        })
      ).allowed
    ).toBe(true);

    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValueOnce(
      session('2026-06-18T20:00:00.000Z')
    );
    const blocked = await evaluateEntrySessionGuard({
      ...baseConfig,
      entryCutoffMinutesBeforeClose: 0,
    });

    expect(isEntrySessionBlocked(blocked)).toBe(true);
    expect(blocked.details.entryCutoffAt).toBe('2026-06-18T20:00:00.000Z');
  });

  it('calculates cutoff from an early close returned by Alpaca', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValue(
      session('2026-11-27T17:30:00.000Z', {
        tradingDate: '2026-11-27',
        sessionOpenAt: '2026-11-27T14:30:00.000Z',
        sessionCloseAt: '2026-11-27T18:00:00.000Z',
      })
    );

    const result = await evaluateEntrySessionGuard(baseConfig);

    expect(isEntrySessionBlocked(result)).toBe(true);
    expect(result.details.entryCutoffAt).toBe('2026-11-27T17:30:00.000Z');
  });

  it('blocks invalid windows when start is at or after cutoff', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValue(
      session('2026-06-18T16:00:00.000Z')
    );

    const result = await evaluateEntrySessionGuard({
      ...baseConfig,
      entryStartMinutesAfterOpen: 200,
      entryCutoffMinutesBeforeClose: 190,
    });

    expect(isEntrySessionBlocked(result)).toBe(true);
    expect(result.details.status).toBe('invalid_window');
  });

  it('fails closed when Alpaca session verification fails', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockRejectedValue(
      new Error('bad clock')
    );

    const result = await evaluateEntrySessionGuard(baseConfig);

    expect(isEntrySessionBlocked(result)).toBe(true);
    if (isEntrySessionBlocked(result)) {
      expect(result.statusCode).toBe(503);
      expect(result.details.rule).toBe('market_clock_unavailable');
      expect(result.details.error?.message).toBe('bad clock');
    }
  });

  it('allows with degraded details when Alpaca fails and fail-open is configured', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockRejectedValue(
      new Error('malformed response')
    );

    const result = await evaluateEntrySessionGuard({
      ...baseConfig,
      failClosedOnMarketClockError: false,
    });

    expect(result.allowed).toBe(true);
    expect(result.details.status).toBe('degraded');
    if (result.allowed) {
      expect(result.degraded).toBe(true);
    }
    expect(result.details.error?.message).toBe('malformed response');
  });

  it('blocks safely when Alpaca returns an open market without a usable session window', async () => {
    mocks.getAlpacaMarketSessionSnapshot.mockResolvedValue(
      session('2026-06-18T16:00:00.000Z', {
        sessionOpenAt: null,
        sessionCloseAt: null,
      })
    );

    const result = await evaluateEntrySessionGuard(baseConfig);

    expect(isEntrySessionBlocked(result)).toBe(true);
    expect(result.details.status).toBe('unavailable');
  });
});
