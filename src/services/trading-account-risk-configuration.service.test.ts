import { PositionSizingType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock('../db/prisma.js', () => ({
  prisma: { $transaction: mocks.transaction },
}));

import {
  assertAccountRiskConfiguration,
  evaluateAccountRiskConfiguration,
  withAccountRiskConfigurationTransaction,
} from './trading-account-risk-configuration.service.js';

function accountSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    allocationId: 10,
    enabled: true,
    entriesEnabled: true,
    sizingType: PositionSizingType.MAX_NOTIONAL,
    fixedQty: null,
    maxPositionNotional: 4_000,
    reservedNotional: 5_000,
    ...overrides,
  };
}

function configurationState(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    maxDeployableNotional: 100_000,
    allocations: [
      {
        id: 10,
        enabled: true,
        maxAllocatedNotional: 20_000,
        maxOpenPositions: 4,
        maxPositionNotional: 5_000,
        accountSubscriptions: [accountSubscription()],
      },
    ],
    accountSubscriptions: [],
    ...overrides,
  };
}

function codes(state: ReturnType<typeof configurationState>, candidate = {}) {
  return evaluateAccountRiskConfiguration(state, candidate).map(
    (item) => item.code
  );
}

describe('account risk configuration validator', () => {
  it('runs hierarchy writes at serializable isolation', async () => {
    mocks.transaction.mockImplementationOnce(async (operation) =>
      operation({ id: 'transaction-client' })
    );

    await expect(
      withAccountRiskConfigurationTransaction(async () => 'saved')
    ).resolves.toBe('saved');
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('throws a structured conflict containing all relevant violations', async () => {
    const client = {
      tradingAccount: {
        findUnique: vi.fn().mockResolvedValue(
          configurationState({
            accountSubscriptions: [
              accountSubscription({
                id: 30,
                allocationId: null,
                reservedNotional: null,
              }),
            ],
          })
        ),
      },
    } as any;

    await expect(
      assertAccountRiskConfiguration(client, 1, {
        accountSubscription: accountSubscription({
          id: 30,
          allocationId: null,
          reservedNotional: null,
        }),
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Account risk configuration is invalid.',
      details: {
        violations: expect.arrayContaining([
          expect.objectContaining({
            code: 'ACCOUNT_SUBSCRIPTION_ALLOCATION_REQUIRED',
            path: 'allocationId',
            tradingAccountId: 1,
            accountSubscriptionId: 30,
          }),
          expect.objectContaining({
            code: 'ACCOUNT_SUBSCRIPTION_RESERVATION_REQUIRED',
            path: 'reservedNotional',
          }),
        ]),
      },
    });
  });

  it('rejects a subscription reservation above the allocation position ceiling', () => {
    expect(
      codes(configurationState(), {
        accountSubscription: accountSubscription({
          id: 20,
          reservedNotional: 50_000,
          maxPositionNotional: 4_000,
        }),
      })
    ).toContain('ACCOUNT_SUBSCRIPTION_RESERVATION_EXCEEDS_POSITION_LIMIT');
  });

  it('rejects aggregate reservations above the allocation budget', () => {
    const state = configurationState();
    state.allocations[0]!.accountSubscriptions.push(
      accountSubscription({ id: 21, reservedNotional: 16_000 })
    );

    expect(codes(state)).toContain('ALLOCATION_RESERVED_NOTIONAL_EXCEEDED');
  });

  it('rejects reducing an allocation below active reservations', () => {
    expect(
      codes(configurationState(), {
        allocation: {
          id: 10,
          enabled: true,
          maxAllocatedNotional: 4_000,
          maxOpenPositions: 4,
          maxPositionNotional: 4_000,
        },
      })
    ).toContain('ALLOCATION_RESERVED_NOTIONAL_EXCEEDED');
  });

  it('rejects enabled allocation totals above account deployable capital', () => {
    expect(
      codes(configurationState(), {
        account: { maxDeployableNotional: 10_000 },
      })
    ).toContain('ACCOUNT_ALLOCATION_TOTAL_EXCEEDED');
  });

  it('requires an account deployable ceiling for an operational hierarchy', () => {
    expect(
      codes(configurationState({ maxDeployableNotional: null }))
    ).toContain('ACCOUNT_DEPLOYABLE_NOTIONAL_REQUIRED');
  });

  it('returns allocation and reservation violations together for active entries', () => {
    const result = codes(configurationState(), {
      accountSubscription: accountSubscription({
        id: 20,
        allocationId: null,
        reservedNotional: null,
      }),
    });

    expect(result).toEqual(
      expect.arrayContaining([
        'ACCOUNT_SUBSCRIPTION_ALLOCATION_REQUIRED',
        'ACCOUNT_SUBSCRIPTION_RESERVATION_REQUIRED',
      ])
    );
  });

  it('rejects allocation assignment outside the trading account', () => {
    expect(
      codes(configurationState(), {
        accountSubscription: accountSubscription({ id: 20, allocationId: 999 }),
      })
    ).toContain('ACCOUNT_SUBSCRIPTION_ALLOCATION_ACCOUNT_MISMATCH');
  });

  it('rejects MAX_NOTIONAL sizing above the subscription reservation', () => {
    expect(
      codes(configurationState(), {
        accountSubscription: accountSubscription({
          id: 20,
          maxPositionNotional: 6_000,
          reservedNotional: 5_000,
        }),
      })
    ).toContain('ACCOUNT_SUBSCRIPTION_MAX_NOTIONAL_EXCEEDS_RESERVATION');
  });

  it('rejects disabling an allocation with active entry subscriptions', () => {
    expect(
      codes(configurationState(), {
        allocation: {
          id: 10,
          enabled: false,
          maxAllocatedNotional: 20_000,
          maxOpenPositions: 4,
          maxPositionNotional: 5_000,
        },
      })
    ).toContain('ALLOCATION_HAS_ENTRY_ENABLED_SUBSCRIPTIONS');
  });

  it('allows dormant legacy subscriptions to remain unassigned', () => {
    const state = configurationState({
      accountSubscriptions: [
        accountSubscription({
          id: 30,
          allocationId: null,
          entriesEnabled: false,
          reservedNotional: null,
        }),
      ],
    });

    expect(codes(state)).not.toContain(
      'ACCOUNT_SUBSCRIPTION_ALLOCATION_REQUIRED'
    );
  });

  it('rejects incomplete enabled allocations and position limits above total budgets', () => {
    const incomplete = configurationState();
    incomplete.allocations[0]!.maxOpenPositions = null;
    expect(codes(incomplete)).toContain('ALLOCATION_LIMITS_INCOMPLETE');

    const inconsistent = configurationState();
    inconsistent.allocations[0]!.maxPositionNotional = 25_000;
    expect(codes(inconsistent)).toContain(
      'ALLOCATION_POSITION_LIMIT_EXCEEDS_TOTAL'
    );
  });
});
