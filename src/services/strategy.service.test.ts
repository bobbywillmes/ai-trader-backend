import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  strategyFindMany: vi.fn(),
  strategyFindUnique: vi.fn(),
  strategyUpdateMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  systemEventCreate: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: (() => {
    const transaction = {
      strategy: {
        findUnique: mocks.strategyFindUnique,
        updateMany: mocks.strategyUpdateMany,
      },
      subscription: {
        findMany: mocks.subscriptionFindMany,
      },
      systemEvent: {
        create: mocks.systemEventCreate,
      },
    };

    return {
    strategy: {
      findMany: mocks.strategyFindMany,
      findUnique: mocks.strategyFindUnique,
    },
    subscription: {
      findMany: mocks.subscriptionFindMany,
    },
      $transaction: vi.fn((callback) => callback(transaction)),
    };
  })(),
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
    mocks.strategyFindUnique
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...updated, subscriptions: current.subscriptions });
    mocks.strategyUpdateMany.mockResolvedValue({ count: 1 });
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.systemEventCreate.mockResolvedValue({ id: 20 });

    await expect(updateStrategyEnabled(1, { enabled: true }, 7)).resolves.toMatchObject({
      changed: true,
      strategy: { id: 1, enabled: true },
      impact: { currentEnabled: true },
    });
    expect(mocks.strategyUpdateMany).toHaveBeenCalledWith({
      where: { id: 1, enabled: false },
      data: { enabled: true },
    });
    expect(mocks.systemEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'strategy_enabled',
        entityType: 'strategy',
        entityId: '1',
        payloadJson: expect.objectContaining({
          previousEnabled: false,
          enabled: true,
          actorUserId: 7,
          totalSubscriptions: 2,
          enabledSubscriptions: 1,
          distinctSymbols: 2,
          distinctTradingAccounts: 2,
          qualifyingMomentumSubscriptions: 0,
        }),
      }),
    });
  });

  it('returns an idempotent response without writing when state already matches', async () => {
    mocks.strategyFindUnique.mockResolvedValue(strategy());

    await expect(updateStrategyEnabled(1, { enabled: false }, 7)).resolves.toMatchObject({
      changed: false,
      strategy: { id: 1, enabled: false },
    });
    expect(mocks.strategyUpdateMany).not.toHaveBeenCalled();
    expect(mocks.systemEventCreate).not.toHaveBeenCalled();
  });

  it('records a strategy_disabled event for a real disable', async () => {
    const current = strategy({ enabled: true });
    mocks.strategyFindUnique
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, enabled: false });
    mocks.strategyUpdateMany.mockResolvedValue({ count: 1 });
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.systemEventCreate.mockResolvedValue({ id: 21 });

    await expect(updateStrategyEnabled(1, { enabled: false }, 8)).resolves.toMatchObject({
      changed: true,
      strategy: { enabled: false },
    });
    expect(mocks.systemEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'strategy_disabled',
        payloadJson: expect.objectContaining({
          previousEnabled: true,
          enabled: false,
          actorUserId: 8,
        }),
      }),
    });
  });

  it('treats a concurrent identical update as an idempotent no-op without an event', async () => {
    const current = strategy();
    mocks.strategyFindUnique
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({
        ...current,
        enabled: true,
        subscriptions: current.subscriptions,
      });
    mocks.strategyUpdateMany.mockResolvedValue({ count: 0 });

    await expect(updateStrategyEnabled(1, { enabled: true }, 7)).resolves.toMatchObject({
      changed: false,
      strategy: { enabled: true },
    });
    expect(mocks.systemEventCreate).not.toHaveBeenCalled();
  });
});
