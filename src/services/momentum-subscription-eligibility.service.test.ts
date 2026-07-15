import { TradingAccountStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  subscriptionFindMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    subscription: {
      findMany: mocks.subscriptionFindMany,
    },
  },
}));

import {
  MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS as REASON,
  evaluateMomentumSubscriptionEligibility,
  resolveActiveMomentumSubscriptionsForSecurity,
  type MomentumSubscriptionEligibilityRecord,
} from './momentum-subscription-eligibility.service.js';

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    enabled: true,
    entriesEnabled: true,
    tradingAccount: {
      id: 10,
      status: TradingAccountStatus.ACTIVE,
    },
    allocation: {
      id: 20,
      enabled: true,
    },
    ...overrides,
  };
}

function subscription(
  overrides: Record<string, unknown> = {}
): MomentumSubscriptionEligibilityRecord {
  return {
    id: 1,
    key: 'aapl-momentum',
    enabled: true,
    strategy: {
      id: 30,
      key: 'momentum_stock',
      enabled: true,
    },
    accountSubscriptions: [assignment()],
    ...overrides,
  } as MomentumSubscriptionEligibilityRecord;
}

describe('momentum subscription eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscriptionFindMany.mockResolvedValue([]);
  });

  it('reports when no subscription exists', () => {
    expect(evaluateMomentumSubscriptionEligibility([])).toMatchObject({
      eligible: false,
      subscriptionCount: 0,
      enabledSubscriptionCount: 0,
      reasons: [REASON.NO_SUBSCRIPTION],
    });
  });

  it('reports when all subscriptions are disabled', () => {
    expect(
      evaluateMomentumSubscriptionEligibility([
        subscription({ enabled: false }),
      ])
    ).toMatchObject({
      eligible: false,
      enabledSubscriptionCount: 0,
      reasons: [REASON.NO_ENABLED_SUBSCRIPTION],
    });
  });

  it('does not treat a generic stock subscription as momentum eligible', () => {
    expect(
      evaluateMomentumSubscriptionEligibility([
        subscription({
          strategy: { id: 31, key: 'dip_n_ride_stock', enabled: true },
        }),
      ])
    ).toMatchObject({
      eligible: false,
      reasons: [REASON.NO_MOMENTUM_STRATEGY],
    });
  });

  it('does not treat the system-test momentum strategy as eligible', () => {
    expect(
      evaluateMomentumSubscriptionEligibility([
        subscription({
          strategy: { id: 32, key: 'quick_test_momentum', enabled: true },
        }),
      ])
    ).toMatchObject({
      eligible: false,
      reasons: [REASON.NO_MOMENTUM_STRATEGY],
    });
  });

  it('reports a disabled momentum strategy', () => {
    expect(
      evaluateMomentumSubscriptionEligibility([
        subscription({
          strategy: { id: 30, key: 'momentum_stock', enabled: false },
        }),
      ])
    ).toMatchObject({
      eligible: false,
      reasons: [REASON.STRATEGY_DISABLED],
    });
  });

  it('requires a modern trading-account assignment', () => {
    expect(
      evaluateMomentumSubscriptionEligibility([
        subscription({ accountSubscriptions: [] }),
      ])
    ).toMatchObject({
      eligible: false,
      reasons: [REASON.NO_TRADING_ACCOUNT],
    });
  });

  it('requires an enabled entry assignment', () => {
    expect(
      evaluateMomentumSubscriptionEligibility([
        subscription({
          accountSubscriptions: [assignment({ entriesEnabled: false })],
        }),
      ])
    ).toMatchObject({
      eligible: false,
      reasons: [REASON.ACCOUNT_ASSIGNMENT_DISABLED],
    });
  });

  it('reports disabled accounts and allocations', () => {
    const result = evaluateMomentumSubscriptionEligibility([
      subscription({
        id: 1,
        accountSubscriptions: [
          assignment({
            tradingAccount: {
              id: 10,
              status: TradingAccountStatus.DISABLED,
            },
          }),
        ],
      }),
      subscription({
        id: 2,
        accountSubscriptions: [
          assignment({ id: 101, allocation: { id: 21, enabled: false } }),
        ],
      }),
    ]);

    expect(result).toMatchObject({
      eligible: false,
      reasons: [REASON.ACCOUNT_DISABLED, REASON.ALLOCATION_DISABLED],
    });
  });

  it('returns structured qualifying subscription and assignment context', () => {
    expect(
      evaluateMomentumSubscriptionEligibility([subscription()])
    ).toEqual({
      eligible: true,
      subscriptionCount: 1,
      enabledSubscriptionCount: 1,
      qualifyingSubscriptionIds: [1],
      qualifyingSubscriptions: [
        {
          subscriptionId: 1,
          subscriptionKey: 'aapl-momentum',
          strategyId: 30,
          strategyKey: 'momentum_stock',
          accountAssignments: [
            {
              accountSubscriptionId: 100,
              tradingAccountId: 10,
              allocationId: 20,
            },
          ],
        },
      ],
      reasons: [REASON.ELIGIBLE],
    });
  });

  it('qualifies when eligible and ineligible subscriptions coexist', () => {
    const result = evaluateMomentumSubscriptionEligibility([
      subscription({
        id: 1,
        strategy: { id: 31, key: 'dip_n_ride_stock', enabled: true },
      }),
      subscription({ id: 2, key: 'aapl-momentum-two' }),
    ]);

    expect(result).toMatchObject({
      eligible: true,
      subscriptionCount: 2,
      enabledSubscriptionCount: 2,
      qualifyingSubscriptionIds: [2],
      reasons: [REASON.ELIGIBLE],
    });
  });

  it('loads bounded security subscriptions using the authoritative resolver', async () => {
    mocks.subscriptionFindMany.mockResolvedValue([subscription()]);

    await expect(
      resolveActiveMomentumSubscriptionsForSecurity(42)
    ).resolves.toMatchObject({ eligible: true, qualifyingSubscriptionIds: [1] });

    expect(mocks.subscriptionFindMany).toHaveBeenCalledWith({
      where: { securityId: 42 },
      select: expect.any(Object),
      orderBy: { id: 'asc' },
    });
  });
});
