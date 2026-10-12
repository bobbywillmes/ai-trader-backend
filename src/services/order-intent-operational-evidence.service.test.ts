import { PlatformRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  orderIntent: { findFirst: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  orderIntentMarketPolicyCaptureRollout: { findUnique: vi.fn() },
  orderIntentBrokerPostOpportunity: { count: vi.fn(), findMany: vi.fn() },
  orderIntentBrokerOpportunityEvent: { count: vi.fn(), findMany: vi.fn() },
}));
vi.mock('../db/prisma.js', () => ({ prisma: db }));

import {
  getAccessibleOrderIntentOperationalEvidence,
  listAccessibleOrderIntentHistory,
} from './order-intent-operational-evidence.service.js';

const owner = { id: 1, platformRole: PlatformRole.SYSTEM_OWNER };
const operator = { id: 2, platformRole: PlatformRole.OPERATOR };
const accountUser = { id: 3, platformRole: PlatformRole.ACCOUNT_USER };
const now = new Date('2026-10-12T12:00:00.000Z');

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 41, source: 'signal', symbol: 'SPY', side: 'buy', orderType: 'market', timeInForce: 'day',
    qty: 1, notional: null, limitPrice: null, extendedHours: false, clientOrderId: 'client-41',
    status: 'submitted', blockReason: null, createdAt: now, updatedAt: now,
    tradingAccountId: 7, tradingAccount: { id: 7, displayName: 'Paper' },
    subscriptionId: 5, subscriptionKey: 'spy-entry', tradingAccountSubscriptionId: 9,
    tradingAccountSubscription: { id: 9, subscription: { id: 5, key: 'spy-entry', name: 'SPY Entry', strategy: { id: 4, key: 'dip', name: 'Dip' } } },
    trackedPositionId: null, trackedPosition: null, brokerOrders: [], entryDecision: { id: 88 },
    marketPolicyCoverage: null,
    ...overrides,
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return { opportunityPage: 1, opportunityPageSize: 10, eventPage: 1, eventPageSize: 25, includeRawEvidence: false, ...overrides } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.orderIntent.findFirst.mockResolvedValue(intent());
  db.orderIntentMarketPolicyCaptureRollout.findUnique.mockResolvedValue({ effectiveEpoch: new Date('2026-10-13T00:00:00Z'), deployedAt: now, disabledAt: null });
  db.orderIntentBrokerPostOpportunity.count.mockResolvedValue(0);
  db.orderIntentBrokerPostOpportunity.findMany.mockResolvedValue([]);
  db.orderIntentBrokerOpportunityEvent.count.mockResolvedValue(0);
  db.orderIntentBrokerOpportunityEvent.findMany.mockResolvedValue([]);
});

describe('order intent operational evidence scope and states', () => {
  it.each([operator, accountUser])('puts membership scope in the direct-object lookup for $platformRole', async (user) => {
    await getAccessibleOrderIntentOperationalEvidence(user, 41, options());
    expect(db.orderIntent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 41, tradingAccount: { memberships: { some: { userId: user.id } } } },
    }));
  });

  it('returns the same 404 for an inaccessible guessed intent id', async () => {
    db.orderIntent.findFirst.mockResolvedValue(null);
    await expect(getAccessibleOrderIntentOperationalEvidence(accountUser, 999, options())).rejects.toMatchObject({ statusCode: 404 });
    expect(db.orderIntentBrokerPostOpportunity.findMany).not.toHaveBeenCalled();
  });

  it('distinguishes pre-rollout and post-epoch missing capture', async () => {
    const pre = await getAccessibleOrderIntentOperationalEvidence(owner, 41, options());
    expect(pre.intentStage.state).toBe('PRE_ROLLOUT');
    db.orderIntentMarketPolicyCaptureRollout.findUnique.mockResolvedValue({ effectiveEpoch: new Date('2026-10-01T00:00:00Z'), deployedAt: now, disabledAt: null });
    const missing = await getAccessibleOrderIntentOperationalEvidence(owner, 41, options());
    expect(missing.intentStage.state).toBe('POST_EPOCH_MISSING_CAPTURE');
  });

  it('marks broker lookup found without an opportunity as derived', async () => {
    db.orderIntent.findFirst.mockResolvedValue(intent({ brokerOrders: [{ id: 2, brokerOrderId: 'broker-2' }] }));
    const result = await getAccessibleOrderIntentOperationalEvidence(owner, 41, options());
    expect(result.brokerStage).toMatchObject({ state: 'BROKER_LOOKUP_FOUND_WITHOUT_NEW_POST', stateSource: 'DERIVED_FROM_LIFECYCLE' });
  });

  it('redacts rules, fingerprints and raw evidence for Account Users', async () => {
    db.orderIntent.findFirst.mockResolvedValue(intent({ marketPolicyCoverage: coverage('NONE_VISIBLE') }));
    const result = await getAccessibleOrderIntentOperationalEvidence(accountUser, 41, options());
    expect(result.intentStage.state).toBe('NONE_VISIBLE');
    expect(result.intentStage.coverage!.marketComposition).not.toHaveProperty('sourceSetFingerprint');
    expect(result.intentStage.comparison.attempts[0]!.gates[0]).not.toHaveProperty('allowedStates');
    expect(result.intentStage.comparison.attempts[0]).not.toHaveProperty('rawEvidence');
  });

  it('shows policy rules to Operators but rejects raw evidence requests', async () => {
    db.orderIntent.findFirst.mockResolvedValue(intent({ marketPolicyCoverage: coverage('EXACT') }));
    const result = await getAccessibleOrderIntentOperationalEvidence(operator, 41, options());
    expect(result.intentStage.comparison.attempts[0]!.gates[0]!.allowedStates).toEqual(['UP']);
    await expect(getAccessibleOrderIntentOperationalEvidence(operator, 41, options({ includeRawEvidence: true }))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('returns bounded multiple opportunities, uncertainty, and continuation metadata', async () => {
    db.orderIntentBrokerPostOpportunity.count.mockResolvedValue(22);
    db.orderIntentBrokerPostOpportunity.findMany.mockResolvedValue([opportunity(1), opportunity(2)]);
    const result = await getAccessibleOrderIntentOperationalEvidence(owner, 41, options({ opportunityPageSize: 2 }));
    expect(result.brokerStage.state).toBe('MULTIPLE_POST_OPPORTUNITIES');
    expect(result.brokerStage.pagination).toMatchObject({ total: 22, pageSize: 2, hasMore: true });
    expect(result.brokerStage.opportunities[0]!.events[0]!.eventType).toBe('DELIVERY_UNCERTAIN');
  });
});

describe('historical order intent list', () => {
  it('paginates in SQL and keeps account membership scope in both queries', async () => {
    db.orderIntent.count.mockResolvedValue(1);
    db.orderIntent.findMany.mockResolvedValue([]);
    db.orderIntentMarketPolicyCaptureRollout.findUnique.mockResolvedValue({ effectiveEpoch: now });
    await listAccessibleOrderIntentHistory(accountUser, { accountId: 7, page: 2, pageSize: 25, symbol: 'spy', status: 'submitted' });
    const expectedScope = { tradingAccount: { memberships: { some: { userId: 3 } } }, tradingAccountId: 7, symbol: 'SPY', status: 'submitted' };
    expect(db.orderIntent.count).toHaveBeenCalledWith({ where: expectedScope });
    expect(db.orderIntent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedScope, skip: 25, take: 25 }));
  });
});

function coverage(compositionCapture: 'EXACT' | 'NONE_VISIBLE') {
  return {
    id: 1, orderIntentId: 41, tradingAccountId: 7, accountSubscriptionId: 9,
    enrollmentGenerationId: 3, boundPolicyRevisionId: 4, activePolicyRevisionId: 4,
    marketRegimeAssessmentId: compositionCapture === 'EXACT' ? 12 : null,
    provenance: 'ACTIVE_EXACT', compositionCapture, captureSchemaVersion: 2,
    comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE', capturedAt: now,
    enrollmentGeneration: { id: 3 }, boundPolicyRevision: { id: 4 }, activePolicyRevision: { id: 4 },
    marketRegimeAssessment: { id: 12, sourceSetFingerprint: 'secret-fingerprint' },
    comparisonDelivery: { status: 'COMPLETED' },
    comparisonAttempts: [{
      id: 5, attempt: 1, evidenceAsOf: now, evaluationVersion: 'ORDER_INTENT_MARKET_POLICY_COMPARISON_V1',
      enrollmentDisposition: 'ACTIVE', outcome: compositionCapture === 'NONE_VISIBLE' ? 'INSUFFICIENT_EVIDENCE' : 'ALLOWED',
      reasonCode: compositionCapture === 'NONE_VISIBLE' ? 'NO_COMPOSITION_VISIBLE' : 'ALL_REQUIRED_GATES_PASS',
      authority: 'COMPARE_ONLY', tradingEffect: 'NONE', evidenceJson: { private: true }, createdAt: now,
      gates: [{ id: 6, ordinal: 1, dimension: 'TREND', algorithmVersion: 'TREND_V1', requirement: 'REQUIRED', outcome: 'PASS', observedState: 'UP', sourceHealth: 'AVAILABLE', sourceAssessmentId: 15, allowedStatesJson: ['UP'], reasonCode: 'STATE_ALLOWED', evidenceJson: { private: true }, createdAt: now }],
    }],
    _count: { comparisonAttempts: 1 },
  };
}

function opportunity(sequence: number) {
  return {
    id: sequence, orderIntentId: 41, intentCoverageId: 1, tradingAccountId: 7,
    accountSubscriptionId: 9, enrollmentGenerationId: 3, policyRevisionId: 4,
    clientOrderId: 'client-41', opportunitySequence: sequence, marketRegimeAssessmentId: 12,
    sourceSetFingerprint: 'fingerprint', compositionCapture: 'EXACT', applicability: 'APPLICABLE_ACTIVE',
    comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE', opportunityAt: now, createdAt: now,
    comparisonDelivery: { status: 'PENDING' }, comparisonAttempts: [],
    events: [{ id: sequence, orderIntentId: 41, opportunityId: sequence, sequence: 1, eventType: 'DELIVERY_UNCERTAIN', evidenceJson: {}, occurredAt: now, createdAt: now }],
    _count: { events: 1, comparisonAttempts: 0 },
  };
}
