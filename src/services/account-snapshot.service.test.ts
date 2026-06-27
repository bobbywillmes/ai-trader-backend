import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerAccountSummary } from '../types/broker.js';

const mocks = vi.hoisted(() => ({
  accountSnapshotCreate: vi.fn(),
  accountSnapshotFindFirst: vi.fn(),
  accountSnapshotFindMany: vi.fn(),
  accountSnapshotFindUnique: vi.fn(),
  getNormalizedAccount: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    accountSnapshot: {
      create: mocks.accountSnapshotCreate,
      findFirst: mocks.accountSnapshotFindFirst,
      findMany: mocks.accountSnapshotFindMany,
      findUnique: mocks.accountSnapshotFindUnique,
    },
  },
}));

vi.mock('./account.service.js', () => ({
  getNormalizedAccount: mocks.getNormalizedAccount,
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

import {
  calculateAccountSnapshotExposureMetrics,
  getAccountSnapshotTrends,
  recordAccountSnapshot,
} from './account-snapshot.service.js';

function account(
  overrides: Partial<BrokerAccountSummary> = {}
): BrokerAccountSummary {
  return {
    broker: 'alpaca',
    mode: 'paper',
    status: 'ACTIVE',
    currency: 'USD',
    accountNumber: 'PA123',
    cash: 10000,
    buyingPower: 20000,
    equity: 15000,
    portfolioValue: 15000,
    lastEquity: 14000,
    longMarketValue: 7000,
    shortMarketValue: -1250,
    dayPnL: 1000,
    dayPnLPct: 0.0714285714,
    tradingBlocked: false,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<Awaited<ReturnType<typeof recordAccountSnapshot>>['snapshot']> = {}
) {
  const createdAt = new Date('2026-06-24T15:00:00.000Z');

  return {
    id: 1,
    broker: 'alpaca',
    mode: 'paper',
    accountStatus: 'ACTIVE',
    currency: 'USD',
    accountNumber: 'PA123',
    reason: 'manual',
    runKey: null,
    sourceEntityType: null,
    sourceEntityId: null,
    tradingAccountId: 1,
    cash: 10000,
    buyingPower: 20000,
    equity: 15000,
    portfolioValue: 15000,
    lastEquity: 14000,
    longMarketValue: 7000,
    shortMarketValue: -1250,
    dayPnL: 1000,
    dayPnLPct: 0.0714285714,
    tradingBlocked: false,
    snapshotHash: 'hash-1',
    changed: true,
    rawJson: {},
    createdAt,
    exposure: {
      longExposure: 7000,
      shortExposure: 1250,
      grossExposure: 8250,
      netExposure: 5750,
      grossExposurePct: 55,
    },
    ...overrides,
  };
}

describe('account snapshot service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountSnapshotFindUnique.mockResolvedValue(null);
    mocks.accountSnapshotFindFirst.mockResolvedValue(null);
    mocks.accountSnapshotFindMany.mockResolvedValue([]);
    mocks.getNormalizedAccount.mockResolvedValue(account());
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.accountSnapshotCreate.mockImplementation(({ data }) =>
      Promise.resolve(
        snapshot({
          ...data,
          createdAt: new Date('2026-06-24T15:00:00.000Z'),
        })
      )
    );
  });

  it('stores exposure values when recording a snapshot', async () => {
    await recordAccountSnapshot({ reason: 'manual', force: true });

    expect(mocks.accountSnapshotCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tradingAccountId: 1,
          longMarketValue: 7000,
          shortMarketValue: -1250,
        }),
      })
    );
  });

  it('includes exposure changes in the snapshot hash', async () => {
    await recordAccountSnapshot({ reason: 'manual', force: true });

    const firstCall = mocks.accountSnapshotCreate.mock.calls[0];

    expect(firstCall).toBeDefined();

    if (firstCall === undefined) {
      throw new Error('Expected first account snapshot create call.');
    }

    const firstHash = firstCall[0].data.snapshotHash as string;

    mocks.accountSnapshotFindFirst.mockResolvedValue(
      snapshot({ snapshotHash: firstHash })
    );
    mocks.getNormalizedAccount.mockResolvedValue(
      account({ longMarketValue: 7001 })
    );

    await recordAccountSnapshot({ reason: 'scheduled_midday' });

    const secondCall = mocks.accountSnapshotCreate.mock.calls[1];

    expect(secondCall).toBeDefined();

    if (secondCall === undefined) {
      throw new Error('Expected second account snapshot create call.');
    }

    const secondCreate = secondCall[0].data;

    expect(secondCreate.snapshotHash).not.toBe(firstHash);
    expect(secondCreate.changed).toBe(true);
  });

  it('calculates derived gross, net, and percentage exposure metrics', () => {
    const metrics = calculateAccountSnapshotExposureMetrics({
        equity: 15000,
        longMarketValue: 7000,
        shortMarketValue: -1250,
      });

    expect(metrics).toMatchObject({
      longExposure: 7000,
      shortExposure: 1250,
      grossExposure: 8250,
      netExposure: 5750,
    });
    expect(metrics.grossExposurePct).toBeCloseTo(55);
  });

  it('returns unavailable derived exposure metrics for historical null values', () => {
    expect(
      calculateAccountSnapshotExposureMetrics({
        equity: 15000,
        longMarketValue: null,
        shortMarketValue: null,
      })
    ).toEqual({
      longExposure: null,
      shortExposure: null,
      grossExposure: null,
      netExposure: null,
      grossExposurePct: null,
    });
  });

  it('returns null gross exposure percentage when equity is zero', () => {
    expect(
      calculateAccountSnapshotExposureMetrics({
        equity: 0,
        longMarketValue: 100,
        shortMarketValue: -50,
      }).grossExposurePct
    ).toBeNull();
  });

  it('queries trend snapshots with date range, mode, limit, and chronological output', async () => {
    mocks.accountSnapshotFindMany.mockResolvedValue([
      snapshot({ id: 2, createdAt: new Date('2026-06-24T16:00:00.000Z') }),
      snapshot({ id: 1, createdAt: new Date('2026-06-24T15:00:00.000Z') }),
    ]);

    const dateFrom = new Date('2026-06-24T14:00:00.000Z');
    const dateTo = new Date('2026-06-24T17:00:00.000Z');
    const result = await getAccountSnapshotTrends({
      dateFrom,
      dateTo,
      mode: 'paper',
      limit: 100,
    });

    expect(mocks.accountSnapshotFindMany).toHaveBeenCalledWith({
      where: {
        createdAt: {
          gte: dateFrom,
          lte: dateTo,
        },
        mode: 'paper',
        tradingAccountId: 1,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    expect(result.snapshots.map((item) => item.id)).toEqual([1, 2]);
    expect(result.filters).toMatchObject({
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString(),
      mode: 'paper',
      limit: 100,
    });
  });

  it('caps trend query limits', async () => {
    await getAccountSnapshotTrends({ limit: 9000 });

    expect(mocks.accountSnapshotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tradingAccountId: 1,
        },
        take: 2000,
      })
    );
  });
});
