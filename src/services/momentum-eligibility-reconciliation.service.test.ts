import { MomentumCandidateState, TradingAccountStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { buildMomentumEligibilityReconciliationPlan } from './momentum-eligibility-reconciliation.service.js';

function subscription() {
  return {
    id: 1,
    key: 'aapl-momentum',
    enabled: true,
    strategy: { id: 1, key: 'momentum_stock', enabled: true },
    accountSubscriptions: [
      {
        id: 1,
        enabled: true,
        entriesEnabled: true,
        tradingAccount: { id: 1, status: TradingAccountStatus.ACTIVE },
        allocation: { id: 1, enabled: true },
      },
    ],
  };
}

function security(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    symbol: 'AAPL',
    momentumUniverseMember: { enabled: true },
    subscriptions: [subscription()],
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'candidate-1',
    symbol: 'AAPL',
    securityId: null,
    state: MomentumCandidateState.DISCOVERED,
    expiresAt: new Date('2026-07-16T00:00:00.000Z'),
    ...overrides,
  };
}

function impact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'impact-1',
    symbol: 'AAPL',
    securityId: null,
    ...overrides,
  };
}

const now = new Date('2026-07-15T20:00:00.000Z');

describe('momentum eligibility reconciliation plan', () => {
  it('resolves candidate and ticker-impact symbols case-insensitively', () => {
    const plan = buildMomentumEligibilityReconciliationPlan({
      now,
      securities: [security({ symbol: 'aapl' })],
      candidates: [candidate({ symbol: ' AAPL ' })],
      tickerImpacts: [impact({ symbol: 'AaPl' })],
    });

    expect(plan.report).toMatchObject({
      mode: 'DRY_RUN',
      candidatesResolvedToSecurity: 1,
      candidateSecurityLinksToApply: 1,
      tickerImpactsResolvedToSecurity: 1,
      tickerImpactSecurityLinksToApply: 1,
      candidatesInUniverse: 1,
      momentumSubscriptionEligible: 1,
    });
  });

  it('classifies unmatched, ambiguous, and conflicting identities without guessing', () => {
    const plan = buildMomentumEligibilityReconciliationPlan({
      now,
      securities: [
        security({ id: 1, symbol: 'AAPL' }),
        security({ id: 2, symbol: 'aapl' }),
        security({ id: 3, symbol: 'MSFT' }),
      ],
      candidates: [
        candidate({ id: 'unmatched', symbol: 'UNKNOWN' }),
        candidate({ id: 'ambiguous' }),
        candidate({ id: 'conflicting', securityId: 3 }),
      ],
      tickerImpacts: [
        impact({ id: 'unmatched-impact', symbol: 'UNKNOWN' }),
        impact({ id: 'ambiguous-impact' }),
        impact({ id: 'conflicting-impact', securityId: 3 }),
      ],
    });

    expect(plan.report).toMatchObject({
      candidatesUnmatched: 1,
      candidatesAmbiguous: 1,
      candidatesConflicting: 1,
      tickerImpactsUnmatched: 1,
      tickerImpactsAmbiguous: 1,
      tickerImpactsConflicting: 1,
      markedIneligible: 3,
    });
    expect(plan.candidateSecurityLinks).toEqual([]);
    expect(plan.tickerImpactSecurityLinks).toEqual([]);
  });

  it('expires stale and ownership-ineligible active candidates but preserves history', () => {
    const plan = buildMomentumEligibilityReconciliationPlan({
      now,
      securities: [
        security(),
        security({
          id: 2,
          symbol: 'MSFT',
          momentumUniverseMember: null,
          subscriptions: [],
        }),
        security({
          id: 3,
          symbol: 'NVDA',
          momentumUniverseMember: { enabled: false },
        }),
      ],
      candidates: [
        candidate({ id: 'stale', securityId: 1, expiresAt: now }),
        candidate({ id: 'outside', symbol: 'MSFT', securityId: 2 }),
        candidate({ id: 'disabled', symbol: 'NVDA', securityId: 3 }),
        candidate({
          id: 'historical',
          securityId: 1,
          state: MomentumCandidateState.DISMISSED,
        }),
      ],
      tickerImpacts: [],
    });

    expect(plan.report).toMatchObject({
      expiredDueToAge: 1,
      markedIneligible: 2,
      unchangedHistoricalRecords: 1,
    });
    expect(plan.candidateIdsToExpire).toEqual(['stale', 'outside', 'disabled']);
  });

  it('reports research-only candidates without expiring them', () => {
    const plan = buildMomentumEligibilityReconciliationPlan({
      now,
      securities: [security({ subscriptions: [] })],
      candidates: [candidate({ securityId: 1 })],
      tickerImpacts: [],
    });

    expect(plan.report).toMatchObject({
      candidatesInUniverse: 1,
      notMomentumSubscriptionEligible: 1,
      markedIneligible: 0,
    });
    expect(plan.candidateIdsToExpire).toEqual([]);
  });

  it('produces no further writes after the first apply plan is reflected in data', () => {
    const first = buildMomentumEligibilityReconciliationPlan({
      apply: true,
      now,
      securities: [security()],
      candidates: [candidate({ expiresAt: now })],
      tickerImpacts: [impact()],
    });

    expect(first.report.mode).toBe('APPLY');
    expect(first.candidateSecurityLinks).toHaveLength(1);
    expect(first.tickerImpactSecurityLinks).toHaveLength(1);
    expect(first.candidateIdsToExpire).toEqual(['candidate-1']);

    const second = buildMomentumEligibilityReconciliationPlan({
      now,
      securities: [security()],
      candidates: [
        candidate({
          securityId: 1,
          state: MomentumCandidateState.EXPIRED,
          expiresAt: now,
        }),
      ],
      tickerImpacts: [impact({ securityId: 1 })],
    });

    expect(second.candidateSecurityLinks).toEqual([]);
    expect(second.tickerImpactSecurityLinks).toEqual([]);
    expect(second.candidateIdsToExpire).toEqual([]);
    expect(second.report.unchangedHistoricalRecords).toBe(1);
  });
});
