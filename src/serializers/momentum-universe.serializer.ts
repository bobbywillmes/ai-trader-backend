import type { CatalystSource, Prisma } from '@prisma/client';
import {
  evaluateMomentumSubscriptionEligibility,
  momentumSubscriptionEligibilitySelect,
} from '../services/momentum-subscription-eligibility.service.js';

type UniverseMemberRecord = Prisma.MomentumUniverseMemberGetPayload<{
  include: {
    security: {
      include: {
        _count: {
          select: { subscriptions: true };
        };
        subscriptions: { select: typeof momentumSubscriptionEligibilitySelect };
      };
    };
  };
}>;

type CursorSummary = {
  source: CatalystSource;
  enabled: boolean;
  lastPulledAt: Date | null;
  lastPublishedAt: Date | null;
  consecutiveErrors: number;
  lastError: string | null;
};

export function serializeMomentumUniverseMember(
  member: UniverseMemberRecord,
  cursor: CursorSummary | null
) {
  const { _count, subscriptions, ...security } = member.security;
  const momentumSubscriptionEligibility = evaluateMomentumSubscriptionEligibility(subscriptions);

  return {
    ...member,
    security,
    subscriptionCount: _count.subscriptions,
    momentumSubscriptionEligibility,
    cursor,
  };
}
