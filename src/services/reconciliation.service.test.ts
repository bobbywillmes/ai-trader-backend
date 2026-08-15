import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedPositionFindMany: vi.fn(),
  getNormalizedPositions: vi.fn(),
  getOpenAlpacaOrders: vi.fn(),
  createSystemEvent: vi.fn(),
  markPositionExitStateAttentionRequired: vi.fn(),
  systemEventFindFirst: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
  tradingAccountFindUniqueOrThrow: vi.fn(),
  enumerateLifecycleAccounts: vi.fn(),
  brokerOrderFindMany: vi.fn(),
  brokerActivityFindMany: vi.fn(),
  orderIntentFindMany: vi.fn(),
  positionExitStateFindMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    trackedPosition: {
      findMany: mocks.trackedPositionFindMany,
    },
    systemEvent: {
      findFirst: mocks.systemEventFindFirst,
    },
    tradingAccount: {
      findUniqueOrThrow: mocks.tradingAccountFindUniqueOrThrow,
    },
    brokerOrder: {
      findMany: mocks.brokerOrderFindMany,
    },
    brokerActivity: {
      findMany: mocks.brokerActivityFindMany,
    },
    orderIntent: {
      findMany: mocks.orderIntentFindMany,
    },
    positionExitState: {
      findMany: mocks.positionExitStateFindMany,
    },
  },
}));

vi.mock('./positions.service.js', () => ({
  getNormalizedPositions: mocks.getNormalizedPositions,
}));

vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getOpenAlpacaOrders: mocks.getOpenAlpacaOrders,
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

vi.mock('./position-exit-state.service.js', () => ({
  markPositionExitStateAttentionRequired:
    mocks.markPositionExitStateAttentionRequired,
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));
vi.mock('./lifecycle-account-eligibility.service.js', () => ({
  enumerateLifecycleAccounts: mocks.enumerateLifecycleAccounts,
}));

import {
  refineHistoricalMissingOrderFindings,
  findHistoricalUnattributedLifecycleRecords,
  reconcileEligibleTradingAccounts,
  reconcileTradingAccount,
  reconcileSnapshots,
  ReconciliationBrokerUnavailableError,
  runReconciliationCheck,
} from './reconciliation.service.js';

describe('reconcileSnapshots', () => {
  it('reports an active tracked position missing from broker open positions', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
        },
      ],
      brokerPositions: [],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tracked_position_missing_at_broker',
        severity: 'warn',
        entityType: 'trackedPosition',
        entityId: '101',
        symbol: 'SPY',
      }),
    ]);
  });

  it('reports a broker position with no active tracked position', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [],
      brokerPositions: [
        {
          broker: 'alpaca',
          symbol: 'QQQ',
          qty: '1',
          side: 'long',
        },
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'broker_position_untracked',
        severity: 'critical',
        entityType: 'brokerPosition',
        symbol: 'QQQ',
      }),
    ]);
  });

  it('reports a missing protective trailing-stop order after target unlock', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
          exitState: {
            targetUnlocked: true,
            trailClientOrderId: null,
            trailBrokerOrderId: null,
          },
        },
      ],
      brokerPositions: [
        {
          broker: 'alpaca',
          symbol: 'SPY',
          qty: '1',
          side: 'long',
        },
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'trail_order_missing_after_unlock',
        severity: 'critical',
        entityType: 'trackedPosition',
        entityId: '101',
        symbol: 'SPY',
        attentionCode: 'trail_order_missing_after_unlock',
      }),
    ]);
  });

  it('reports a problem broker status for a protective trailing-stop order', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
          exitState: {
            targetUnlocked: true,
            trailClientOrderId: 'ai-exit-trail-SPY-101',
            trailBrokerOrderId: 'alpaca-order-123',
            trailOrderStatus: 'accepted',
          },
        },
      ],
      brokerPositions: [
        {
          broker: 'alpaca',
          symbol: 'SPY',
          qty: '1',
          side: 'long',
        },
      ],
      brokerOrders: [
        {
          broker: 'alpaca',
          id: 'alpaca-order-123',
          client_order_id: 'ai-exit-trail-SPY-101',
          symbol: 'SPY',
          side: 'sell',
          type: 'trailing_stop',
          status: 'rejected',
        },
      ],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'trail_order_problem_status',
          severity: 'critical',
          entityType: 'trackedPosition',
          entityId: '101',
          symbol: 'SPY',
          attentionCode: 'trail_order_rejected',
        }),
      ])
    );
  });

  it('reports a trailing-stop status mismatch between backend and broker', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
          exitState: {
            targetUnlocked: true,
            trailClientOrderId: 'ai-exit-trail-SPY-101',
            trailBrokerOrderId: 'alpaca-order-123',
            trailOrderStatus: 'accepted',
          },
        },
      ],
      brokerPositions: [
        {
          broker: 'alpaca',
          symbol: 'SPY',
          qty: '1',
          side: 'long',
        },
      ],
      brokerOrders: [
        {
          broker: 'alpaca',
          id: 'alpaca-order-123',
          client_order_id: 'ai-exit-trail-SPY-101',
          symbol: 'SPY',
          side: 'sell',
          type: 'trailing_stop',
          status: 'new',
        },
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'trail_order_status_mismatch',
        severity: 'warn',
        entityType: 'trackedPosition',
        entityId: '101',
        symbol: 'SPY',
      }),
    ]);
  });

  it('does not report healthy matching position state', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
          exitState: {
            targetUnlocked: false,
          },
        },
      ],
      brokerPositions: [
        {
          broker: 'alpaca',
          symbol: 'SPY',
          qty: '1',
          side: 'long',
        },
      ],
    });

    expect(findings).toEqual([]);
  });
});

describe('position attribution reconciliation integrity', () => {
  it('surfaces a local-only repair deep link without broker diagnosis', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [{
        id: 73, tradingAccountId: 1, broker: 'alpaca', symbol: 'AAPL', status: 'open',
        side: 'long', qty: 3, subscriptionId: null,
        tradingAccountSubscriptionId: null, configSnapshotJson: null,
      }],
      brokerPositions: [{ broker: 'alpaca', symbol: 'AAPL', side: 'long', qty: 3 }],
      brokerOrders: [], localOrders: [],
    });
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'position_attribution_missing', entityType: 'trackedPosition', entityId: '73',
      details: expect.objectContaining({ tradingAccountId: 1, trackedPositionId: 73, repairType: 'RESOLVE_POSITION_ATTRIBUTION' }),
    }));
    expect(mocks.getOpenAlpacaOrders).not.toHaveBeenCalled();
  });
});

describe('refineHistoricalMissingOrderFindings', () => {
  const missingFinding = {
    code: 'local_nonterminal_order_missing_at_broker' as const,
    severity: 'warn' as const,
    entityType: 'brokerOrder' as const,
    entityId: 'client:client-1',
    symbol: 'DIA',
    message: 'missing',
  };
  const candidate = {
    brokerOrderId: 'broker-1',
    clientOrderId: 'client-1',
    symbol: 'DIA',
    classifications: ['FULL_FILL_LOCAL_EVIDENCE'],
    brokerLookup: null,
    matchedTrackedPositionId: 51,
  };

  it('reports definitive local terminal evidence as stale local status', () => {
    const findings = refineHistoricalMissingOrderFindings(
      [missingFinding],
      [candidate as never]
    );
    expect(findings[0]).toMatchObject({
      code: 'local_order_status_stale_terminal_broker_order',
      details: {
        classifications: ['FULL_FILL_LOCAL_EVIDENCE'],
        matchedTrackedPositionId: 51,
      },
    });
  });

  it('does not call a historically confirmed nonterminal order missing', () => {
    const findings = refineHistoricalMissingOrderFindings(
      [missingFinding],
      [
        {
          ...candidate,
          classifications: ['NONTERMINAL_BROKER_CONFIRMED'],
        } as never,
      ]
    );
    expect(findings).toEqual([]);
  });

  it('preserves unresolved findings with precise lookup evidence', () => {
    const findings = refineHistoricalMissingOrderFindings(
      [missingFinding],
      [
        {
          ...candidate,
          classifications: ['BROKER_LOOKUP_FAILED'],
          brokerLookup: { error: 'lookup_failed' },
        } as never,
      ]
    );
    expect(findings[0]).toMatchObject({
      code: 'local_nonterminal_order_missing_at_broker',
      details: {
        classifications: ['BROKER_LOOKUP_FAILED'],
        brokerLookup: { error: 'lookup_failed' },
      },
    });
  });
});

describe('runReconciliationCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.systemEventFindFirst.mockResolvedValue(null);
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.tradingAccountFindUniqueOrThrow.mockResolvedValue({
      id: 1,
      displayName: 'Bobby Paper',
      environment: 'PAPER',
    });
    mocks.brokerOrderFindMany.mockResolvedValue([]);
    mocks.brokerActivityFindMany.mockResolvedValue([]);
    mocks.orderIntentFindMany.mockResolvedValue([]);
    mocks.positionExitStateFindMany.mockResolvedValue([]);
  });

  it('loads backend and broker snapshots, then creates system events for findings', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        id: 101,
        broker: 'alpaca',
        symbol: 'SPY',
        status: 'open',
        side: 'long',
        qty: 1,
        exitState: {
          targetUnlocked: true,
          trailClientOrderId: null,
          trailBrokerOrderId: null,
          trailOrderStatus: null,
          attentionRequired: false,
        },
      },
    ]);

    mocks.getNormalizedPositions.mockResolvedValue([
      {
        broker: 'alpaca',
        symbol: 'SPY',
        qty: 1,
        side: 'long',
      },
    ]);

    mocks.getOpenAlpacaOrders.mockResolvedValue([]);
    mocks.createSystemEvent.mockResolvedValue({});

    const result = await runReconciliationCheck();

    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith({
      where: {
        tradingAccountId: 1,
        status: {
          in: ['open', 'closing'],
        },
      },
      include: {
        exitState: true,
      },
      orderBy: {
        symbol: 'asc',
      },
    });
    expect(mocks.getNormalizedPositions).toHaveBeenCalledWith(
      1,
      'reconciliation_check'
    );
    expect(mocks.getOpenAlpacaOrders).toHaveBeenCalledWith(
      1,
      'reconciliation_check'
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'trail_order_missing_after_unlock',
        severity: 'critical',
        entityType: 'trackedPosition',
        entityId: '101',
        symbol: 'SPY',
      }),
    ]);

    expect(result.eventCount).toBe(1);
    expect(result.persistedEvents).toBe(true);

    expect(mocks.createSystemEvent).toHaveBeenCalledWith({
      type: 'reconciliation.trail_order_missing_after_unlock',
      entityType: 'trackedPosition',
      entityId: '101',
      tradingAccountId: 1,
      message:
        'SPY target is unlocked, but no protective trailing-stop order is linked.',
      payloadJson: expect.objectContaining({
        code: 'trail_order_missing_after_unlock',
        severity: 'critical',
        symbol: 'SPY',
        attentionCode: 'trail_order_missing_after_unlock',
      }),
    });

    expect(result.attentionUpdateCount).toBe(1);
    expect(result.persistedAttention).toBe(true);

    expect(result.skippedDuplicateEventCount).toBe(0);

    expect(mocks.markPositionExitStateAttentionRequired).toHaveBeenCalledWith({
      trackedPositionId: 101,
      code: 'trail_order_missing_after_unlock',
      message:
        'SPY target is unlocked, but no protective trailing-stop order is linked.',
    });

  });

  it('does not create system events when reconciliation has no findings', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        id: 101,
        broker: 'alpaca',
        symbol: 'SPY',
        status: 'open',
        side: 'long',
        qty: 1,
        exitState: {
          targetUnlocked: false,
          trailClientOrderId: null,
          trailBrokerOrderId: null,
          trailOrderStatus: null,
          attentionRequired: false,
        },
      },
    ]);

    mocks.getNormalizedPositions.mockResolvedValue([
      {
        broker: 'alpaca',
        symbol: 'SPY',
        qty: 1,
        side: 'long',
      },
    ]);

    mocks.getOpenAlpacaOrders.mockResolvedValue([]);

    const result = await runReconciliationCheck();

    expect(result.findings).toEqual([]);
    expect(result.eventCount).toBe(0);
    expect(result.persistedEvents).toBe(true);
    expect(mocks.createSystemEvent).not.toHaveBeenCalled();

    expect(result.attentionUpdateCount).toBe(0);
    expect(result.persistedAttention).toBe(true);
    expect(mocks.markPositionExitStateAttentionRequired).not.toHaveBeenCalled();

  });

  it('can return findings without creating system events when persistEvents is false', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        id: 101,
        broker: 'alpaca',
        symbol: 'SPY',
        status: 'open',
        side: 'long',
        qty: 1,
        exitState: {
          targetUnlocked: true,
          trailClientOrderId: null,
          trailBrokerOrderId: null,
          trailOrderStatus: null,
          attentionRequired: false,
        },
      },
    ]);

    mocks.getNormalizedPositions.mockResolvedValue([
      {
        broker: 'alpaca',
        symbol: 'SPY',
        qty: 1,
        side: 'long',
      },
    ]);

    mocks.getOpenAlpacaOrders.mockResolvedValue([]);

    const result = await runReconciliationCheck({ persistEvents: false });

    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'trail_order_missing_after_unlock',
        severity: 'critical',
        entityType: 'trackedPosition',
        entityId: '101',
        symbol: 'SPY',
      }),
    ]);

    expect(result.eventCount).toBe(0);
    expect(result.persistedEvents).toBe(false);
    expect(mocks.createSystemEvent).not.toHaveBeenCalled();

    expect(result.attentionUpdateCount).toBe(0);
    expect(result.persistedAttention).toBe(false);
    expect(mocks.markPositionExitStateAttentionRequired).not.toHaveBeenCalled();

  });

  it('uses only the explicit account for broker reads, local records, events, and attention updates', async () => {
    mocks.tradingAccountFindUniqueOrThrow.mockResolvedValue({ id: 2, displayName: 'Bobby Live', environment: 'LIVE' });
    mocks.trackedPositionFindMany.mockResolvedValue([{ id: 202, broker: 'alpaca', symbol: 'QQQ', status: 'open', side: 'long', qty: 1, exitState: { targetUnlocked: true, trailClientOrderId: null, trailBrokerOrderId: null, trailOrderStatus: null, attentionRequired: false } }]);
    mocks.getNormalizedPositions.mockResolvedValue([{ broker: 'alpaca', symbol: 'QQQ', qty: 1, side: 'long' }]);
    mocks.getOpenAlpacaOrders.mockResolvedValue([]);

    const result = await reconcileTradingAccount(2, { persistEvents: true, persistAttention: true });

    expect(mocks.resolveDefaultTradingAccountId).not.toHaveBeenCalled();
    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tradingAccountId: 2 }) }));
    expect(mocks.brokerOrderFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tradingAccountId: 2 }) }));
    expect(mocks.orderIntentFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tradingAccountId: 2 }) }));
    expect(mocks.getNormalizedPositions).toHaveBeenCalledWith(2, 'reconciliation_check');
    expect(mocks.getOpenAlpacaOrders).toHaveBeenCalledWith(2, 'reconciliation_check');
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(expect.objectContaining({ tradingAccountId: 2, entityId: '202' }));
    expect(mocks.markPositionExitStateAttentionRequired).toHaveBeenCalledWith(expect.objectContaining({ trackedPositionId: 202 }));
    expect(result.account).toMatchObject({ tradingAccountId: 2, displayName: 'Bobby Live', environment: 'LIVE' });
  });

  it('reports broker state as unavailable and persists no effects when observation fails', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([]);
    mocks.getNormalizedPositions.mockRejectedValue(new Error('active credentials unavailable'));
    mocks.getOpenAlpacaOrders.mockResolvedValue([]);

    await expect(reconcileTradingAccount(2, { persistEvents: true, persistAttention: true }))
      .rejects.toBeInstanceOf(ReconciliationBrokerUnavailableError);
    expect(mocks.createSystemEvent).not.toHaveBeenCalled();
    expect(mocks.markPositionExitStateAttentionRequired).not.toHaveBeenCalled();
  });

  it('skips duplicate reconciliation system events within the de-dupe window while still applying attention', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        id: 101,
        broker: 'alpaca',
        symbol: 'SPY',
        status: 'open',
        side: 'long',
        qty: 1,
        exitState: {
          targetUnlocked: true,
          trailClientOrderId: null,
          trailBrokerOrderId: null,
          trailOrderStatus: null,
          attentionRequired: false,
        },
      },
    ]);

    mocks.getNormalizedPositions.mockResolvedValue([
      {
        broker: 'alpaca',
        symbol: 'SPY',
        qty: 1,
        side: 'long',
      },
    ]);

    mocks.getOpenAlpacaOrders.mockResolvedValue([]);
    mocks.systemEventFindFirst.mockResolvedValue({
      id: 999,
      type: 'reconciliation.trail_order_missing_after_unlock',
      entityType: 'trackedPosition',
      entityId: '101',
    });

    mocks.markPositionExitStateAttentionRequired.mockResolvedValue({});

    const result = await runReconciliationCheck({
      persistEvents: true,
      persistAttention: true,
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'trail_order_missing_after_unlock',
        severity: 'critical',
        entityType: 'trackedPosition',
        entityId: '101',
        symbol: 'SPY',
      }),
    ]);

    expect(result.eventCount).toBe(0);
    expect(result.skippedDuplicateEventCount).toBe(1);
    expect(result.attentionUpdateCount).toBe(1);
    expect(result.persistedEvents).toBe(true);
    expect(result.persistedAttention).toBe(true);

    expect(mocks.createSystemEvent).not.toHaveBeenCalled();

    expect(mocks.markPositionExitStateAttentionRequired).toHaveBeenCalledWith({
      trackedPositionId: 101,
      code: 'trail_order_missing_after_unlock',
      message:
        'SPY target is unlocked, but no protective trailing-stop order is linked.',
    });
  });

});

describe('reconcileEligibleTradingAccounts', () => {
  const eligibleAccount = (id: number) => ({
    tradingAccountId: id,
    displayName: id === 1 ? 'Bobby Paper' : 'Bobby Live',
    broker: 'ALPACA',
    environment: id === 1 ? 'PAPER' : 'LIVE',
    status: 'PAUSED',
    credentialStatus: 'ACTIVE',
    eligible: true,
    reason: 'usable_credentials_with_work',
    exposureSummary: {
      pendingIntents: 0,
      submittingIntents: 0,
      submittedIntents: 0,
      nonterminalOrders: 0,
      activePositions: 1,
      unresolvedActivities: 0,
      unresolvedExitPositions: 0,
      hasLifecycleWork: true,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.systemEventFindFirst.mockResolvedValue(null);
    mocks.trackedPositionFindMany.mockResolvedValue([]);
    mocks.brokerOrderFindMany.mockResolvedValue([]);
    mocks.brokerActivityFindMany.mockResolvedValue([]);
    mocks.orderIntentFindMany.mockResolvedValue([]);
    mocks.positionExitStateFindMany.mockResolvedValue([]);
    mocks.getNormalizedPositions.mockResolvedValue([]);
    mocks.getOpenAlpacaOrders.mockResolvedValue([]);
    mocks.tradingAccountFindUniqueOrThrow.mockImplementation(
      async ({ where }: { where: { id: number } }) => ({
        id: where.id,
        displayName: where.id === 1 ? 'Bobby Paper' : 'Bobby Live',
        environment: where.id === 1 ? 'PAPER' : 'LIVE',
      })
    );
  });

  it('reconciles both accounts sequentially in stable enumerated order', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      eligibleAccount(1),
      eligibleAccount(2),
    ]);

    const result = await reconcileEligibleTradingAccounts();

    expect(
      mocks.getNormalizedPositions.mock.calls.map(([accountId]) => accountId)
    ).toEqual([1, 2]);
    expect(result.results.map((item) => item.account.tradingAccountId)).toEqual([
      1,
      2,
    ]);
  });

  it('isolates one account failure and reports credentialless exposure critically', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      eligibleAccount(1),
      eligibleAccount(2),
      {
        ...eligibleAccount(3),
        eligible: false,
        credentialStatus: null,
        reason: 'credentials_unavailable_with_exposure',
      },
    ]);
    mocks.getNormalizedPositions
      .mockRejectedValueOnce(new Error('paper auth failure'))
      .mockResolvedValueOnce([]);
    mocks.createSystemEvent.mockResolvedValue({});

    const result = await reconcileEligibleTradingAccounts();

    expect(result.results.map((item) => item.outcome)).toEqual([
      'FAILED',
      'PROCESSED',
      'CREDENTIALS_UNAVAILABLE',
    ]);
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reconciliation.credentials_unavailable_with_exposure',
        tradingAccountId: 3,
      })
    );
  });
});

describe('expanded account-scoped reconciliation findings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.brokerActivityFindMany.mockResolvedValue([]);
    mocks.orderIntentFindMany.mockResolvedValue([]);
    mocks.positionExitStateFindMany.mockResolvedValue([]);
  });

  it('reports quantity, side, and local/broker order mismatches independently', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
          side: 'long',
          qty: 2,
        },
      ],
      brokerPositions: [
        { broker: 'alpaca', symbol: 'SPY', side: 'short', qty: '3' },
      ],
      localOrders: [
        {
          broker: 'alpaca',
          id: 'local-only',
          clientOrderId: 'local-client',
          symbol: 'SPY',
        },
      ],
      brokerOrders: [
        {
          broker: 'alpaca',
          id: 'broker-only',
          client_order_id: 'broker-client',
          symbol: 'SPY',
        },
      ],
    });

    expect(findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'position_quantity_mismatch',
        'position_side_mismatch',
        'local_nonterminal_order_missing_at_broker',
        'broker_order_untracked',
      ])
    );
  });

  it('reports historical null-account records without assigning ownership', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      { id: 900, symbol: 'LEGACY' },
    ]);
    mocks.brokerOrderFindMany.mockResolvedValue([
      { id: 901, clientOrderId: 'legacy-order' },
    ]);
    mocks.brokerActivityFindMany.mockResolvedValue([]);
    mocks.orderIntentFindMany.mockResolvedValue([]);
    mocks.positionExitStateFindMany.mockResolvedValue([]);

    const findings = await findHistoricalUnattributedLifecycleRecords();

    expect(findings).toEqual([
      {
        recordType: 'TrackedPosition',
        id: 900,
        safeIdentifier: 'LEGACY',
      },
      {
        recordType: 'BrokerOrder',
        id: 901,
        safeIdentifier: 'legacy-order',
      },
    ]);
    expect(mocks.getNormalizedPositions).not.toHaveBeenCalled();
    expect(mocks.getOpenAlpacaOrders).not.toHaveBeenCalled();
  });
});
