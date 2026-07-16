import { MomentumCandidateState } from '@prisma/client';

import {
  canPrepareMomentumHandoffState,
  isActiveMomentumCandidateState,
  isMomentumCandidateExpired,
} from './momentum-candidate-lifecycle.js';
import {
  evaluateMomentumSubscriptionEligibility,
  type MomentumSubscriptionEligibility,
  type MomentumSubscriptionEligibilityRecord,
} from './momentum-subscription-eligibility.service.js';

export const MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS = {
  CANDIDATE_INACTIVE: 'CANDIDATE_INACTIVE',
  CANDIDATE_EXPIRED: 'CANDIDATE_EXPIRED',
  CANDIDATE_UNCONFIRMED: 'CANDIDATE_UNCONFIRMED',
  CANDIDATE_BLOCKED: 'CANDIDATE_BLOCKED',
  MISSING_SECURITY: 'MISSING_SECURITY',
  OUTSIDE_RESEARCH_UNIVERSE: 'OUTSIDE_RESEARCH_UNIVERSE',
  UNIVERSE_DISABLED: 'UNIVERSE_DISABLED',
  PRICE_SCANNING_DISABLED: 'PRICE_SCANNING_DISABLED',
  ELIGIBLE: 'ELIGIBLE',
} as const;

export type MomentumCandidateEligibilityContext = {
  state: MomentumCandidateState;
  expiresAt: Date | null;
  blockedReason: string | null;
  latestPriceCheck?: { confirmed: boolean } | null;
  security: {
    id: number;
    momentumUniverseMember: {
      enabled: boolean;
      priceScanningEnabled: boolean;
    } | null;
    subscriptions: MomentumSubscriptionEligibilityRecord[];
  } | null;
};

export type MomentumCandidateEligibility = {
  eligible: boolean;
  reasons: string[];
  momentumSubscriptionEligibility: MomentumSubscriptionEligibility;
};

function ineligible(
  reasons: string[],
  momentumSubscriptionEligibility: MomentumSubscriptionEligibility
): MomentumCandidateEligibility {
  return { eligible: false, reasons, momentumSubscriptionEligibility };
}

function researchConfigurationEligibility(
  candidate: MomentumCandidateEligibilityContext,
  now: Date
) {
  const reasons: string[] = [];

  if (!isActiveMomentumCandidateState(candidate.state)) {
    reasons.push(MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.CANDIDATE_INACTIVE);
  }
  if (isMomentumCandidateExpired(candidate.expiresAt, now)) {
    reasons.push(MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.CANDIDATE_EXPIRED);
  }
  if (candidate.security === null) {
    reasons.push(MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.MISSING_SECURITY);
  } else if (candidate.security.momentumUniverseMember === null) {
    reasons.push(
      MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.OUTSIDE_RESEARCH_UNIVERSE
    );
  } else {
    if (!candidate.security.momentumUniverseMember.enabled) {
      reasons.push(MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.UNIVERSE_DISABLED);
    }
    if (!candidate.security.momentumUniverseMember.priceScanningEnabled) {
      reasons.push(
        MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.PRICE_SCANNING_DISABLED
      );
    }
  }

  const subscriptionEligibility = evaluateMomentumSubscriptionEligibility(
    candidate.security?.subscriptions ?? []
  );

  return { reasons: [...new Set(reasons)], subscriptionEligibility };
}

export function evaluateMomentumPriceConfirmationEligibility(
  candidate: MomentumCandidateEligibilityContext,
  now = new Date()
): MomentumCandidateEligibility {
  const { reasons, subscriptionEligibility } = researchConfigurationEligibility(
    candidate,
    now
  );

  return reasons.length > 0
    ? ineligible(reasons, subscriptionEligibility)
    : {
        eligible: true,
        reasons: [MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.ELIGIBLE],
        momentumSubscriptionEligibility: subscriptionEligibility,
      };
}

export function evaluateMomentumHandoffEligibility(
  candidate: MomentumCandidateEligibilityContext,
  now = new Date()
): MomentumCandidateEligibility {
  const { reasons, subscriptionEligibility } = researchConfigurationEligibility(
    candidate,
    now
  );

  if (!subscriptionEligibility.eligible) {
    reasons.push(...subscriptionEligibility.reasons);
  }

  if (!canPrepareMomentumHandoffState(candidate.state)) {
    reasons.push(MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.CANDIDATE_UNCONFIRMED);
  }
  if (candidate.latestPriceCheck?.confirmed !== true) {
    reasons.push(MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.CANDIDATE_UNCONFIRMED);
  }
  if (
    candidate.state === MomentumCandidateState.ENTRY_BLOCKED ||
    candidate.blockedReason !== null
  ) {
    reasons.push(MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.CANDIDATE_BLOCKED);
  }

  const uniqueReasons = [...new Set(reasons)];

  return uniqueReasons.length > 0
    ? ineligible(uniqueReasons, subscriptionEligibility)
    : {
        eligible: true,
        reasons: [MOMENTUM_CANDIDATE_ELIGIBILITY_REASONS.ELIGIBLE],
        momentumSubscriptionEligibility: subscriptionEligibility,
      };
}
