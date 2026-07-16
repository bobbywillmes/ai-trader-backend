import { MomentumCandidateState, Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { ACTIVE_MOMENTUM_CANDIDATE_STATES } from './momentum-candidate-lifecycle.js';

export type ExpireStaleMomentumCandidatesArgs = {
  now?: Date;
  limit?: number;
};

const DEFAULT_INSPECTION_LIMIT = 500;
const MAX_INSPECTION_LIMIT = 1_000;
const MAX_RETURNED_IDS = 100;
const EXPIRATION_REASON = 'EXPIRES_AT_REACHED';

function normalizeLimit(limit: number | undefined) {
  if (limit === undefined) return DEFAULT_INSPECTION_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_INSPECTION_LIMIT;
  return Math.min(limit, MAX_INSPECTION_LIMIT);
}

function activeWhere(): Prisma.MomentumCandidateWhereInput {
  return { state: { in: [...ACTIVE_MOMENTUM_CANDIDATE_STATES] } };
}

export async function expireStaleMomentumCandidates(
  args: ExpireStaleMomentumCandidatesArgs = {}
) {
  const now = args.now ?? new Date();
  const limit = normalizeLimit(args.limit);
  const [activeCount, candidates] = await Promise.all([
    prisma.momentumCandidate.count({ where: activeWhere() }),
    prisma.momentumCandidate.findMany({
      where: activeWhere(),
      select: { id: true, expiresAt: true },
      orderBy: [
        { expiresAt: { sort: 'asc', nulls: 'last' } },
        { id: 'asc' },
      ],
      take: limit,
    }),
  ]);
  const staleIds = candidates.flatMap((candidate) =>
    candidate.expiresAt !== null && candidate.expiresAt <= now
      ? [candidate.id]
      : []
  );
  const updateResult = staleIds.length === 0
    ? { count: 0 }
    : await prisma.momentumCandidate.updateMany({
        where: {
          id: { in: staleIds },
          ...activeWhere(),
          expiresAt: { lte: now },
        },
        data: {
          state: MomentumCandidateState.EXPIRED,
          lastEvaluatedAt: now,
        },
      });
  const staleRemaining = await prisma.momentumCandidate.count({
    where: {
      ...activeWhere(),
      expiresAt: { lte: now },
    },
  });

  return {
    inspected: candidates.length,
    expired: updateResult.count,
    unchanged: candidates.length - staleIds.length,
    skipped: Math.max(0, activeCount - candidates.length),
    staleRemaining,
    expiredCandidateIds: staleIds.slice(0, MAX_RETURNED_IDS),
    expiredCandidateIdsTruncated: staleIds.length > MAX_RETURNED_IDS,
    reasonCounts: updateResult.count === 0
      ? {}
      : { [EXPIRATION_REASON]: updateResult.count },
    asOf: now,
  };
}
