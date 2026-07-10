import type { CatalystSource, Prisma } from '@prisma/client';

type UniverseMemberRecord = Prisma.MomentumUniverseMemberGetPayload<{
  include: {
    security: {
      include: {
        _count: {
          select: { subscriptions: true };
        };
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
  const { _count, ...security } = member.security;

  return {
    ...member,
    security,
    subscriptionCount: _count.subscriptions,
    cursor,
  };
}
