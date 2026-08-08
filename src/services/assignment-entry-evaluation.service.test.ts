import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    ALLOW_LIVE_TRADING: false,
    ALLOW_LIVE_RISK_REDUCING_WRITES: false,
  },
  assignmentFindUniqueOrThrow: vi.fn(),
  resolveSubscriptionOrderInput: vi.fn(),
  resolveSizing: vi.fn(),
  evaluateOrderRisk: vi.fn(),
}));

vi.mock('../config/env.js', () => ({ env: mocks.env }));
vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccountSubscription: {
      findUniqueOrThrow: mocks.assignmentFindUniqueOrThrow,
    },
  },
}));
vi.mock('./subscription.service.js', () => ({
  resolveSubscriptionOrderInput: mocks.resolveSubscriptionOrderInput,
}));
vi.mock('./account-subscription-runtime-sizing.service.js', () => ({
  resolveRuntimeAccountSubscriptionSizing: mocks.resolveSizing,
}));
vi.mock('./risk-gate.service.js', () => ({
  evaluateOrderRisk: mocks.evaluateOrderRisk,
}));

import { evaluateAssignmentEntry, evaluateAssignmentEntryPreviewDiagnostics } from './assignment-entry-evaluation.service.js';

function context(environment: 'PAPER' | 'LIVE') {
  return {
    id: 40,
    subscriptionId: 30,
    allocationId: 7,
    enabled: true,
    entriesEnabled: true,
    exitsEnabled: true,
    sizingType: 'MAX_NOTIONAL',
    fixedQty: null,
    maxPositionNotional: 1_500,
    reservedNotional: null,
    minPositionNotional: null,
    maxQty: null,
    tradingAccount: {
      id: 1,
      displayName: 'Account',
      broker: 'ALPACA',
      environment,
      status: 'ACTIVE',
    },
    subscription: {
      id: 30,
      key: 'dia_dip_core',
      symbol: 'DIA',
      enabled: true,
      security: { id: 1, symbol: 'DIA', enabled: true },
      strategy: { id: 2, key: 'dip', enabled: true },
      exitProfile: { id: 3, key: 'default', enabled: true },
    },
    allocation: { id: 7, key: 'core', enabled: true },
  };
}

const resolvedInput = {
  tradingAccountSubscriptionId: 40,
  tradingAccountId: 1,
  subscriptionId: 30,
  subscriptionKey: 'dia_dip_core',
  symbol: 'DIA',
  side: 'buy' as const,
  signalType: 'entry' as const,
  orderType: 'market' as const,
  timeInForce: 'day' as const,
  extendedHours: false,
};

const sizing = {
  tradingAccountSubscriptionId: 40,
  qty: 3,
  estimatedNotional: 1_425,
  accountSubscription: { id: 40 },
  snapshot: {
    tradingAccountSubscriptionId: 40,
    sizingType: 'MAX_NOTIONAL',
    fixedQty: null,
    maxPositionNotional: 1_500,
    minPositionNotional: null,
    maxQty: null,
    latestPrice: 475,
    latestPriceAt: '2026-07-02T20:00:00.000Z',
    latestPriceSource: 'lastTrade',
    calculatedQty: 3,
    estimatedNotional: 1_425,
  },
};

describe('assignment entry evaluation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.ALLOW_LIVE_TRADING = false;
    mocks.env.ALLOW_LIVE_RISK_REDUCING_WRITES = false;
    mocks.resolveSubscriptionOrderInput.mockResolvedValue(resolvedInput);
    mocks.assignmentFindUniqueOrThrow.mockResolvedValue(context('PAPER'));
    mocks.resolveSizing.mockResolvedValue(sizing);
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: true,
      details: { entrySession: { checked: true, marketOpen: true } },
    });
  });

  it('returns authoritative identity, sizing, price evidence, and risk evidence', async () => {
    const result = await evaluateAssignmentEntry({
      input: {
        tradingAccountSubscriptionId: 40,
        subscriptionKey: 'dia_dip_core',
        extendedHours: false,
      },
    });

    expect(result).toMatchObject({
      context: {
        id: 40,
        subscription: { id: 30, symbol: 'DIA' },
        tradingAccount: { id: 1, environment: 'PAPER' },
      },
      input: { qty: 3 },
      referencePrice: 475,
      priceEvidence: {
        observedAt: '2026-07-02T20:00:00.000Z',
        source: 'lastTrade',
      },
      estimatedNotional: 1_425,
      permitsIntentCreation: true,
      outcomeCode: 'ENTRY_ELIGIBLE',
    });
    expect(mocks.evaluateOrderRisk).toHaveBeenCalledWith(
      expect.objectContaining({ tradingAccountSubscriptionId: 40, qty: 3 }),
      expect.objectContaining({
        tradingAccountId: 1,
        requestedNotionalOverride: 1_425,
      })
    );
  });

  it('continues preview diagnostics past a session block without permitting entry', async () => {
    mocks.evaluateOrderRisk
      .mockResolvedValueOnce({
        allowed: false,
        statusCode: 409,
        reason: 'Regular market is closed. New entries are blocked.',
        details: { rule: 'market_closed', marketOpen: false },
      })
      .mockResolvedValueOnce({
        allowed: false,
        statusCode: 409,
        reason: 'Account maximum position capacity would be exceeded.',
        details: {
          rule: 'account_max_open_positions_exceeded',
          usage: { activePositionCount: 4, pendingEntryPositionCount: 1, currentAccountPositionSlots: 5 },
          effectiveEntryLimits: { limits: { maxOpenPositions: { value: 5 } } },
        },
      });

    const result = await evaluateAssignmentEntryPreviewDiagnostics({
      input: { tradingAccountSubscriptionId: 40, subscriptionKey: 'dia_dip_core', extendedHours: false },
    });

    expect(result).toMatchObject({
      permitsIntentCreation: false,
      risk: { allowed: false, details: { rule: 'account_max_open_positions_exceeded' } },
      blockers: [
        { code: 'market_closed' },
        { code: 'account_max_open_positions_exceeded' },
      ],
      session: { rule: 'market_closed', marketOpen: false },
    });
    expect(mocks.evaluateOrderRisk).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      enforceEntrySessionGuard: false,
    }));
  });

  it.each([
    [false, true],
    [true, false],
  ])('blocks LIVE before risk when policy flags are %s/%s', async (allowTrading, allowRiskWrites) => {
    mocks.env.ALLOW_LIVE_TRADING = allowTrading;
    mocks.env.ALLOW_LIVE_RISK_REDUCING_WRITES = allowRiskWrites;
    mocks.assignmentFindUniqueOrThrow.mockResolvedValue(context('LIVE'));

    const result = await evaluateAssignmentEntry({
      input: { tradingAccountSubscriptionId: 40, extendedHours: false },
    });

    expect(result).toMatchObject({
      permitsIntentCreation: false,
      outcomeCode: 'LIVE_ENTRY_POLICY_BLOCKED',
      blockers: [{ code: 'live_entry_policy_blocked' }],
      risk: { allowed: false, statusCode: 403 },
    });
    expect(mocks.evaluateOrderRisk).not.toHaveBeenCalled();
  });

  it('keeps ordinary risk failures distinct from LIVE policy failures', async () => {
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: false,
      statusCode: 409,
      reason: 'Account maximum position capacity would be exceeded.',
      details: { rule: 'account_max_open_positions_exceeded' },
    });

    const result = await evaluateAssignmentEntry({
      input: { tradingAccountSubscriptionId: 40, extendedHours: false },
    });

    expect(result).toMatchObject({
      permitsIntentCreation: false,
      outcomeCode: 'ENTRY_RISK_BLOCKED',
      blockers: [{ code: 'account_max_open_positions_exceeded' }],
    });
  });

  it('allows LIVE to continue when both existing entry-write flags are enabled', async () => {
    mocks.env.ALLOW_LIVE_TRADING = true;
    mocks.env.ALLOW_LIVE_RISK_REDUCING_WRITES = true;
    mocks.assignmentFindUniqueOrThrow.mockResolvedValue(context('LIVE'));

    const result = await evaluateAssignmentEntry({
      input: { tradingAccountSubscriptionId: 40, extendedHours: false },
    });

    expect(result.permitsIntentCreation).toBe(true);
    expect(mocks.evaluateOrderRisk).toHaveBeenCalledTimes(1);
  });

  it('keeps PAPER evaluation independent of LIVE policy flags', async () => {
    const result = await evaluateAssignmentEntry({
      input: { tradingAccountSubscriptionId: 40, extendedHours: false },
    });

    expect(result.permitsIntentCreation).toBe(true);
    expect(mocks.evaluateOrderRisk).toHaveBeenCalledTimes(1);
  });
});
