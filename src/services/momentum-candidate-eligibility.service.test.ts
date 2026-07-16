import { MomentumCandidateState, TradingAccountStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS as REASON,
  evaluateMomentumHandoffEligibility,
  evaluateMomentumPriceConfirmationEligibility,
  type MomentumCandidateEligibilityContext,
} from './momentum-candidate-eligibility.service.js';

function candidate(
  overrides: Partial<MomentumCandidateEligibilityContext> = {}
): MomentumCandidateEligibilityContext {
  return {
    state: MomentumCandidateState.DISCOVERED,
    expiresAt: new Date('2026-07-16T00:00:00.000Z'),
    blockedReason: null,
    latestPriceCheck: null,
    security: {
      id: 1,
      momentumUniverseMember: {
        enabled: true,
        priceScanningEnabled: true,
      },
      subscriptions: [
        {
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
        },
      ],
    },
    ...overrides,
  };
}

const now = new Date('2026-07-15T20:00:00.000Z');

describe('momentum candidate eligibility', () => {
  it('allows an active configured candidate to request price confirmation', () => {
    expect(evaluateMomentumPriceConfirmationEligibility(candidate(), now)).toMatchObject({
      eligible: true,
      reasons: [REASON.ELIGIBLE],
    });
  });

  it.each([
    [REASON.MISSING_SECURITY, { security: null }],
    [
      REASON.OUTSIDE_RESEARCH_UNIVERSE,
      {
        security: {
          ...candidate().security!,
          momentumUniverseMember: null,
        },
      },
    ],
    [
      REASON.UNIVERSE_DISABLED,
      {
        security: {
          ...candidate().security!,
          momentumUniverseMember: { enabled: false, priceScanningEnabled: true },
        },
      },
    ],
    [
      REASON.PRICE_SCANNING_DISABLED,
      {
        security: {
          ...candidate().security!,
          momentumUniverseMember: { enabled: true, priceScanningEnabled: false },
        },
      },
    ],
    [REASON.CANDIDATE_EXPIRED, { expiresAt: now }],
    [REASON.CANDIDATE_INACTIVE, { state: MomentumCandidateState.EXPIRED }],
  ])('blocks price confirmation with %s', (reason, overrides) => {
    expect(
      evaluateMomentumPriceConfirmationEligibility(
        candidate(overrides as Partial<MomentumCandidateEligibilityContext>),
        now
      )
    ).toMatchObject({ eligible: false, reasons: expect.arrayContaining([reason]) });
  });

  it('allows research price confirmation without a trading subscription', () => {
    expect(
      evaluateMomentumPriceConfirmationEligibility(
        candidate({
          security: { ...candidate().security!, subscriptions: [] },
        }),
        now
      )
    ).toMatchObject({
      eligible: true,
      reasons: [REASON.ELIGIBLE],
      momentumSubscriptionEligibility: {
        eligible: false,
        reasons: ['NO_SUBSCRIPTION'],
      },
    });
  });

  it('retains subscription eligibility as a handoff requirement', () => {
    expect(
      evaluateMomentumHandoffEligibility(
        candidate({
          state: MomentumCandidateState.ENTRY_READY,
          latestPriceCheck: { confirmed: true },
          security: { ...candidate().security!, subscriptions: [] },
        }),
        now
      )
    ).toMatchObject({ eligible: false, reasons: ['NO_SUBSCRIPTION'] });
  });

  it('requires ENTRY_READY, a confirmed check, and no blocking state for handoff', () => {
    expect(
      evaluateMomentumHandoffEligibility(
        candidate({
          state: MomentumCandidateState.ENTRY_READY,
          latestPriceCheck: { confirmed: true },
        }),
        now
      )
    ).toMatchObject({ eligible: true, reasons: [REASON.ELIGIBLE] });

    expect(
      evaluateMomentumHandoffEligibility(
        candidate({
          state: MomentumCandidateState.ENTRY_BLOCKED,
          latestPriceCheck: { confirmed: false },
          blockedReason: 'PRICE_BELOW_MINIMUM',
        }),
        now
      )
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining([
        REASON.CANDIDATE_UNCONFIRMED,
        REASON.CANDIDATE_BLOCKED,
      ]),
    });
  });
});
