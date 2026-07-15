import { AssetType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../errors/http-error.js';

const mocks = vi.hoisted(() => ({
  securityFindUnique: vi.fn(),
  candidateFindUnique: vi.fn(),
  candidateFindMany: vi.fn(),
  getTickerAggregateBars: vi.fn(),
  getTickerDailyCandles: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    security: { findUnique: mocks.securityFindUnique },
    momentumCandidate: {
      findUnique: mocks.candidateFindUnique,
      findMany: mocks.candidateFindMany,
    },
  },
}));

vi.mock('./massive-market-data.service.js', () => ({
  getTickerAggregateBars: mocks.getTickerAggregateBars,
  getTickerDailyCandles: mocks.getTickerDailyCandles,
}));

import {
  getMomentumMarketChart,
  resetMomentumMarketChartCacheForTests,
} from './momentum-market-chart.service.js';

const security = {
  id: 7,
  symbol: 'AAPL',
  name: 'Apple Inc.',
  assetType: AssetType.STOCK,
};

describe('getMomentumMarketChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMomentumMarketChartCacheForTests();
    mocks.securityFindUnique.mockResolvedValue(security);
    mocks.candidateFindUnique.mockResolvedValue(null);
    mocks.candidateFindMany.mockResolvedValue([]);
    mocks.getTickerDailyCandles.mockResolvedValue([
      { date: '2026-07-09', open: 95, high: 101, low: 94, close: 100, volume: 1 },
      { date: '2026-07-10', open: 101, high: 106, low: 100, close: 105, volume: 1 },
    ]);
    mocks.getTickerAggregateBars.mockResolvedValue([
      {
        time: '2026-07-10T12:00:00.000Z',
        open: 101, high: 103, low: 100, close: 102,
        volume: 1000, vwap: 101.5, transactions: 20,
      },
      {
        time: '2026-07-10T14:00:00.000Z',
        open: 102, high: 106, low: 101, close: 105,
        volume: 3000, vwap: 104.5, transactions: 40,
      },
    ]);
  });

  it('returns bounded chart data and New York session reference levels', async () => {
    const result = await getMomentumMarketChart(
      'AAPL',
      {
        interval: '1m',
        from: new Date('2026-07-10T08:00:00.000Z'),
        to: new Date('2026-07-10T20:00:00.000Z'),
      },
      { now: new Date('2026-07-10T18:00:00.000Z') }
    );

    expect(mocks.securityFindUnique).toHaveBeenCalledWith({ where: { symbol: 'AAPL' } });
    expect(mocks.getTickerAggregateBars).toHaveBeenCalledWith('AAPL', {
      multiplier: 1,
      timespan: 'minute',
      from: '1783670400000',
      to: '1783713600000',
    });
    expect(result).toMatchObject({
      security: { id: '7', symbol: 'AAPL', name: 'Apple Inc.' },
      query: { interval: '1m', timezone: 'America/New_York', adjusted: true },
      bars: [
        { timestamp: '2026-07-10T12:00:00.000Z', volume: '1000', transactions: 20 },
        { timestamp: '2026-07-10T14:00:00.000Z', volume: '3000', transactions: 40 },
      ],
      referenceLevels: {
        previousClose: 100,
        sessionVwap: 103.75,
        premarketHigh: 103,
        regularSessionHigh: 106,
      },
      markers: [],
      source: { provider: 'MASSIVE', cached: false },
    });
  });

  it.each([
    ['EDT', '2026-07-10T18:00:00.000Z', '2026-07-10T08:00:00.000Z'],
    ['EST', '2026-01-10T18:00:00.000Z', '2026-01-10T09:00:00.000Z'],
  ])('defaults a one-minute %s request to 4:00 New York time', async (_label, now, expectedFrom) => {
    mocks.getTickerDailyCandles.mockResolvedValue([]);
    mocks.getTickerAggregateBars.mockResolvedValue([]);

    const result = await getMomentumMarketChart(
      'AAPL',
      { interval: '1m' },
      { now: new Date(now) }
    );

    expect(result.query.from).toBe(expectedFrom);
  });

  it('rejects an excessive interval range before requesting market data', async () => {
    await expect(
      getMomentumMarketChart('AAPL', {
        interval: '1m',
        from: new Date('2026-07-08T18:00:00.000Z'),
        to: new Date('2026-07-10T18:00:00.000Z'),
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { code: 'CHART_RANGE_TOO_LARGE', maximumRangeDays: 1 },
    });
    expect(mocks.getTickerAggregateBars).not.toHaveBeenCalled();
  });

  it('requires an existing supported stock security', async () => {
    mocks.securityFindUnique.mockResolvedValueOnce(null);

    await expect(
      getMomentumMarketChart('MISSING', { interval: '1m' })
    ).rejects.toMatchObject({ statusCode: 404, details: { code: 'SECURITY_NOT_FOUND' } });

    mocks.securityFindUnique.mockResolvedValueOnce({ ...security, assetType: AssetType.INDEX });
    await expect(
      getMomentumMarketChart('SPX', { interval: '1m' })
    ).rejects.toMatchObject({ statusCode: 400, details: { code: 'UNSUPPORTED_SECURITY' } });
  });

  it('returns an empty chart without fabricating reference levels', async () => {
    mocks.getTickerAggregateBars.mockResolvedValue([]);
    mocks.getTickerDailyCandles.mockResolvedValue([]);

    const result = await getMomentumMarketChart('AAPL', { interval: '1m' });

    expect(result.bars).toEqual([]);
    expect(result.referenceLevels).toEqual({
      previousClose: null,
      sessionVwap: null,
      premarketHigh: null,
      regularSessionHigh: null,
    });
  });

  it('does not expose Massive provider error details', async () => {
    mocks.getTickerAggregateBars.mockRejectedValue(
      new HttpError(502, 'raw provider secret detail', { upstreamStatus: 429 })
    );

    await expect(
      getMomentumMarketChart('AAPL', { interval: '1m' })
    ).rejects.toMatchObject({
      statusCode: 503,
      message: 'Market data provider is temporarily unavailable.',
      details: { code: 'MARKET_DATA_PROVIDER_UNAVAILABLE' },
    });
  });

  it('serves identical market data from cache while loading fresh markers', async () => {
    const query = {
      interval: '1m' as const,
      from: new Date('2026-07-10T08:00:00.000Z'),
      to: new Date('2026-07-10T20:00:00.000Z'),
    };
    const first = await getMomentumMarketChart('AAPL', query, {
      now: new Date('2026-07-10T18:00:00.000Z'),
    });
    mocks.candidateFindMany.mockResolvedValueOnce([{
      id: 'candidate-1', symbol: 'AAPL',
      discoveredAt: new Date('2026-07-10T15:00:00.000Z'),
      catalystEvent: null, priceChecks: [], scannerHandoffs: [],
    }]);
    const second = await getMomentumMarketChart('AAPL', query, {
      now: new Date('2026-07-10T18:00:10.000Z'),
    });

    expect(first.source.cached).toBe(false);
    expect(second.source.cached).toBe(true);
    expect(second.source.fetchedAt).toBe(first.source.fetchedAt);
    expect(mocks.getTickerAggregateBars).toHaveBeenCalledOnce();
    expect(mocks.getTickerDailyCandles).toHaveBeenCalledOnce();
    expect(mocks.candidateFindMany).toHaveBeenCalledTimes(2);
    expect(second.markers).toEqual([
      expect.objectContaining({ type: 'CANDIDATE_DISCOVERED', candidateId: 'candidate-1' }),
    ]);
  });

  it('builds markers only from stored candidate records', async () => {
    mocks.candidateFindUnique.mockResolvedValue({
      id: 'candidate-1', symbol: 'AAPL',
      discoveredAt: new Date('2026-07-10T13:00:00.000Z'),
      catalystEvent: {
        id: 'catalyst-1',
        publishedAt: new Date('2026-07-10T12:00:00.000Z'),
        receivedAt: new Date('2026-07-10T12:05:00.000Z'),
      },
      priceChecks: [{
        id: 'check-1', observedAt: new Date('2026-07-10T14:00:00.000Z'),
        lastPrice: { toString: () => '105.25' },
        decision: 'ENTRY_READY', confirmed: true, blockedReason: null,
        aboveVwap: true, sessionVwap: { toString: () => '104.50' },
        priceActionScore: 100, volumeScore: 80, totalConfirmationScore: 88,
        dayVolume: 1_000_000n, recentVolume: 50_000n, relativeVolume: null,
      }],
      scannerHandoffs: [{
        id: 'handoff-1', status: 'SENT',
        preparedAt: new Date('2026-07-10T14:05:00.000Z'),
        sentAt: new Date('2026-07-10T14:06:00.000Z'),
        updatedAt: new Date('2026-07-10T14:06:00.000Z'),
      }],
    });

    const result = await getMomentumMarketChart('AAPL', {
      interval: '1m', candidateId: 'candidate-1',
      from: new Date('2026-07-10T08:00:00.000Z'),
      to: new Date('2026-07-10T20:00:00.000Z'),
    });

    expect(result.markers.map((marker) => marker.type)).toEqual([
      'CATALYST_PUBLISHED', 'CATALYST_RECEIVED', 'CANDIDATE_DISCOVERED',
      'PRICE_CHECK', 'ENTRY_READY', 'HANDOFF_PREPARED', 'HANDOFF_SENT',
    ]);
    expect(result.markers.find((marker) => marker.type === 'PRICE_CHECK')).toMatchObject({
      price: 105.25,
      metadata: {
        dayVolume: '1000000', recentVolume: '50000', relativeVolume: null,
        sessionVwap: '104.50', totalConfirmationScore: 88,
      },
    });
  });

  it('rejects a candidate that belongs to another symbol', async () => {
    mocks.candidateFindUnique.mockResolvedValue({
      id: 'candidate-1', symbol: 'MSFT', discoveredAt: new Date(),
      catalystEvent: null, priceChecks: [], scannerHandoffs: [],
    });

    await expect(getMomentumMarketChart('AAPL', {
      interval: '1m', candidateId: 'candidate-1',
    })).rejects.toMatchObject({
      statusCode: 400, details: { code: 'CANDIDATE_SYMBOL_MISMATCH' },
    });
  });
});
