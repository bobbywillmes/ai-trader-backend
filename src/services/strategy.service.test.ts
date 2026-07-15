import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  strategyFindMany: vi.fn(),
  strategyFindUnique: vi.fn(),
  strategyUpdate: vi.fn(),
  subscriptionFindMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    strategy: {
      findMany: mocks.strategyFindMany,
      findUnique: mocks.strategyFindUnique,
      update: mocks.strategyUpdate,
    },
    subscription: {
      findMany: mocks.subscriptionFindMany,
    },
  },
}));

import {
  getStrategies,
  getStrategy,
  getStrategyChangeImpact,
  updateStrategyEnabled,
} from './strategy.service.js';

function strategy(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    key: 'momentum_stock',
    name: 'Momentum Stock',
    description: 'Stock continuation strategy',
    allowedSymbolsJson: null,
    enabled: false,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    subscriptions: [
      {
        id: 10,
        enabled: true,
        symbol: 'MSFT',
        exitProfile: { id: 4, key: 'momentum', name: 'Momentum Exit' },
        tradingAccount: { id: 2, displayName: 'Paper Account' },
        accountSubscriptions: [
          { tradingAccount: { id: 2, displayName: 'Paper Account' } },
        ],
      },
      {
        id: 11,
        enabled: false,
        symbol: 'AAPL',
        exitProfile: { id: 4, key: 'momentum', name: 'Momentum Exit' },
        tradingAccount: null,
        accountSubscriptions: [
          { tradingAccount: { id: 3, displayName: 'Pilot Account' } },
        ],
      },
    ],
    ...overrides,
  };
}

describe('strategy service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves strategy fields and adds sorted usage summaries without N+1 queries', async () => {
    mocks.strategyFindMany.mockResolvedValue([strategy()]);

    await expect(getStrategies()).resolves.toEqual([
      expect.objectContaining({
        id: 1,
        key: 'momentum_stock',
        enabled: false,
        subscriptionCount: 2,
        activeSubscriptionCount: 1,
        symbols: ['AAPL', 'MSFT'],
        tradingAccounts: [
          { id: 2, displayName: 'Paper Account' },
          { id: 3, displayName: 'Pilot Account' },
        ],
        exitProfiles: [
          {
            id: 4,
            key: 'momentum',
            name: 'Momentum Exit',
            subscriptionCount: 2,
          },
        ],
      }),
    ]);
    expect(mocks.strategyFindMany).toHaveBeenCalledOnce();
    expect(mocks.strategyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { key: 'asc' } }),
    );
  });

  it('returns a page-bounded strategy detail with usage and momentum implications', async () => {
    mocks.strategyFindUnique.mockResolvedValue(strategy());
    mocks.subscriptionFindMany
      .mockResolvedValueOnce([
        {
          id: 10,
          key: 'msft-momentum',
          name: 'MSFT Momentum',
          symbol: 'MSFT',
          enabled: true,
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await getStrategy(1, { page: 2, pageSize: 1 });

    expect(result).toMatchObject({
      strategy: { id: 1, key: 'momentum_stock', enabled: false },
      usage: {
        totalSubscriptions: 2,
        enabledSubscriptions: 1,
        disabledSubscriptions: 1,
        symbols: ['AAPL', 'MSFT'],
      },
      subscriptions: {
        data: [{ id: 10, key: 'msft-momentum' }],
        pagination: { page: 2, pageSize: 1, total: 2, totalPages: 2 },
      },
      implications: {
        momentumStrategy: true,
        enabledMomentumSubscriptions: 1,
        currentlyQualifyingMomentumSubscriptions: 0,
      },
    });
    expect(mocks.subscriptionFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ skip: 1, take: 1 }),
    );
  });

  it('returns derived change impact without claiming subscriptions are enabled', async () => {
    mocks.strategyFindUnique.mockResolvedValue(strategy());

    await expect(getStrategyChangeImpact(1)).resolves.toMatchObject({
      strategyId: 1,
      currentEnabled: false,
      totalSubscriptions: 2,
      enabledSubscriptions: 1,
      disabledSubscriptions: 1,
      distinctSymbols: 2,
      distinctTradingAccounts: 2,
      enabledMomentumSubscriptions: 1,
      enablingCouldMakeMomentumSubscriptionsEligible: true,
      disablingMakesEnabledMomentumSubscriptionsIneligible: false,
      effects: expect.arrayContaining([
        'No subscription records will be changed.',
        'No signals or orders will be created by this change.',
      ]),
    });
  });

  it('uses the standard not-found error for detail and impact reads', async () => {
    mocks.strategyFindUnique.mockResolvedValue(null);

    await expect(getStrategyChangeImpact(999)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Strategy id 999 was not found.',
    });
  });

  it('changes only the strategy enabled state', async () => {
    const current = strategy();
    const { subscriptions: _subscriptions, ...updated } = {
      ...current,
      enabled: true,
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
    };
    mocks.strategyFindUnique.mockResolvedValue(current);
    mocks.strategyUpdate.mockResolvedValue(updated);

    await expect(updateStrategyEnabled(1, { enabled: true })).resolves.toMatchObject({
      changed: true,
      strategy: { id: 1, enabled: true },
      impact: { currentEnabled: true },
    });
    expect(mocks.strategyUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { enabled: true },
    });
    expect(mocks.subscriptionFindMany).not.toHaveBeenCalled();
  });

  it('returns an idempotent response without writing when state already matches', async () => {
    mocks.strategyFindUnique.mockResolvedValue(strategy());

    await expect(updateStrategyEnabled(1, { enabled: false })).resolves.toMatchObject({
      changed: false,
      strategy: { id: 1, enabled: false },
    });
    expect(mocks.strategyUpdate).not.toHaveBeenCalled();
  });
});
