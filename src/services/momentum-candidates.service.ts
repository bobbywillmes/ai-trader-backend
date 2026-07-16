import {
  CatalystSentiment,
  CatalystTickerRole,
  MomentumCandidateState,
  Prisma,
  type MomentumCandidate,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';
import { HttpError } from '../errors/http-error.js';
import { ACTIVE_MOMENTUM_CANDIDATE_STATES } from './momentum-candidate-lifecycle.js';

export type MomentumCandidateFilters = {
  symbol?: string;
  state?: MomentumCandidateState;
  limit?: number;
};

export type GenerateMomentumCandidatesArgs = {
  minCatalystScore?: number;
  recentSince?: Date;
  now?: Date;
  expiresInHours?: number;
  take?: number;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_MIN_CATALYST_SCORE = 60;
const DEFAULT_RECENT_LOOKBACK_HOURS = 24;
const DEFAULT_EXPIRES_IN_HOURS = 24;

export const MOMENTUM_CANDIDATE_DISCOVERY_SKIP_REASONS = {
  UNKNOWN_SECURITY: 'UNKNOWN_SECURITY',
  OUTSIDE_RESEARCH_UNIVERSE: 'OUTSIDE_RESEARCH_UNIVERSE',
  UNIVERSE_DISABLED: 'UNIVERSE_DISABLED',
  DUPLICATE_ACTIVE_CANDIDATE: 'DUPLICATE_ACTIVE_CANDIDATE',
  STALE_CATALYST: 'STALE_CATALYST',
} as const;

type MomentumCandidateDiscoverySkipReason =
  (typeof MOMENTUM_CANDIDATE_DISCOVERY_SKIP_REASONS)[keyof typeof MOMENTUM_CANDIDATE_DISCOVERY_SKIP_REASONS];
function normalizeLimit(limit: number | undefined) {
  if (!Number.isInteger(limit) || limit === undefined || limit <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(limit, MAX_LIMIT);
}

function normalizeSymbol(value: string | undefined) {
  const symbol = value?.trim().toUpperCase();

  return symbol ? symbol : undefined;
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function defaultRecentSince(now: Date) {
  return addHours(now, -DEFAULT_RECENT_LOOKBACK_HOURS);
}

function buildCandidateReason(impact: {
  totalCatalystScore: number;
  sentimentReasoning: string | null;
}) {
  return impact.sentimentReasoning
    ? impact.sentimentReasoning
    : `Positive catalyst impact scored ${impact.totalCatalystScore}.`;
}

function buildRawSnapshot(impact: {
  id: string;
  symbol: string;
  sentiment: CatalystSentiment;
  sentimentReasoning: string | null;
  totalCatalystScore: number;
  relevanceScore: number;
  actionabilityScore: number;
  freshnessScore: number;
  sourceQualityScore: number;
  catalystRole: CatalystTickerRole | null;
  catalystEventId: string;
  catalystEvent: {
    id: string;
    source: string;
    sourceExternalId: string | null;
    title: string;
    sourceUrl: string | null;
    publishedAt: Date | null;
    receivedAt: Date;
  };
}) {
  return {
    catalystImpact: {
      id: impact.id,
      symbol: impact.symbol,
      sentiment: impact.sentiment,
      sentimentReasoning: impact.sentimentReasoning,
      totalCatalystScore: impact.totalCatalystScore,
      relevanceScore: impact.relevanceScore,
      actionabilityScore: impact.actionabilityScore,
      freshnessScore: impact.freshnessScore,
      sourceQualityScore: impact.sourceQualityScore,
      catalystRole: impact.catalystRole,
    },
    catalystEvent: {
      id: impact.catalystEvent.id,
      source: impact.catalystEvent.source,
      sourceExternalId: impact.catalystEvent.sourceExternalId,
      title: impact.catalystEvent.title,
      sourceUrl: impact.catalystEvent.sourceUrl,
      publishedAt: impact.catalystEvent.publishedAt?.toISOString() ?? null,
      receivedAt: impact.catalystEvent.receivedAt.toISOString(),
    },
  } satisfies Prisma.InputJsonValue;
}

function candidateInclude() {
  return {
    catalystEvent: true,
    catalystImpact: true,
  } satisfies Prisma.MomentumCandidateInclude;
}

export async function listMomentumCandidates(
  filters: MomentumCandidateFilters = {}
) {
  const where: Prisma.MomentumCandidateWhereInput = {};
  const symbol = normalizeSymbol(filters.symbol);

  if (symbol !== undefined) {
    where.symbol = symbol;
  }

  if (filters.state !== undefined) {
    where.state = filters.state;
  }

  return prisma.momentumCandidate.findMany({
    where,
    orderBy: [
      {
        totalScore: 'desc',
      },
      {
        discoveredAt: 'desc',
      },
    ],
    take: normalizeLimit(filters.limit),
    include: candidateInclude(),
  });
}

export async function getMomentumCandidateById(id: string) {
  const candidate = await prisma.momentumCandidate.findUnique({
    where: { id },
    include: candidateInclude(),
  });

  if (!candidate) {
    throw new HttpError(404, 'Momentum candidate not found.');
  }

  return candidate;
}

export async function generateMomentumCandidatesFromCatalysts(
  args: GenerateMomentumCandidatesArgs = {}
) {
  const now = args.now ?? new Date();
  const minCatalystScore =
    args.minCatalystScore ?? DEFAULT_MIN_CATALYST_SCORE;
  const recentSince = args.recentSince ?? defaultRecentSince(now);
  const expiresAt = addHours(
    now,
    Math.max(1, args.expiresInHours ?? DEFAULT_EXPIRES_IN_HOURS)
  );

  const impacts = await prisma.catalystTickerImpact.findMany({
    where: {
      sentiment: CatalystSentiment.POSITIVE,
      totalCatalystScore: {
        gte: minCatalystScore,
      },
      symbol: {
        not: '',
      },
      blockedReason: null,
      createdAt: {
        gte: recentSince,
      },
      OR: [
        {
          catalystRole: null,
        },
        {
          catalystRole: {
            not: CatalystTickerRole.TANGENTIAL_MENTION,
          },
        },
      ],
    },
    orderBy: [
      {
        totalCatalystScore: 'desc',
      },
      {
        createdAt: 'desc',
      },
    ],
    take: args.take === undefined ? MAX_LIMIT : normalizeLimit(args.take),
    include: {
      catalystEvent: {
        select: {
          id: true,
          source: true,
          sourceExternalId: true,
          title: true,
          sourceUrl: true,
          publishedAt: true,
          receivedAt: true,
        },
      },
      security: {
        select: {
          id: true,
          symbol: true,
          momentumUniverseMember: {
            select: {
              id: true,
              enabled: true,
            },
          },
        },
      },
    },
  });

  const eligibleSecurityIds = [
    ...new Set(
      impacts.flatMap((impact) =>
        impact.security?.momentumUniverseMember?.enabled
          ? [impact.security.id]
          : []
      )
    ),
  ];
  const existingActiveCandidates =
    eligibleSecurityIds.length === 0
      ? []
      : await prisma.momentumCandidate.findMany({
          where: {
            securityId: { in: eligibleSecurityIds },
            state: { in: [...ACTIVE_MOMENTUM_CANDIDATE_STATES] },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: { securityId: true },
        });
  const activeSecurityIds = new Set(
    existingActiveCandidates.flatMap((candidate) =>
      candidate.securityId === null ? [] : [candidate.securityId]
    )
  );
  const candidates: MomentumCandidate[] = [];
  const skippedImpacts: Array<{
    catalystImpactId: string;
    symbol: string;
    reason: MomentumCandidateDiscoverySkipReason;
  }> = [];
  const skipCounts = Object.fromEntries(
    Object.values(MOMENTUM_CANDIDATE_DISCOVERY_SKIP_REASONS).map((reason) => [
      reason,
      0,
    ])
  ) as Record<MomentumCandidateDiscoverySkipReason, number>;

  function skipImpact(
    impact: { id: string; symbol: string },
    reason: MomentumCandidateDiscoverySkipReason
  ) {
    skipCounts[reason] += 1;
    skippedImpacts.push({
      catalystImpactId: impact.id,
      symbol: impact.symbol,
      reason,
    });
    logger.info(
      {
        catalystImpactId: impact.id,
        symbol: impact.symbol,
        reason,
      },
      'Momentum candidate discovery skipped catalyst impact.'
    );
  }

  for (const impact of impacts) {
    const symbol = normalizeSymbol(impact.symbol);

    if (!symbol) {
      continue;
    }

    if (impact.createdAt < recentSince) {
      skipImpact(impact, MOMENTUM_CANDIDATE_DISCOVERY_SKIP_REASONS.STALE_CATALYST);
      continue;
    }

    if (impact.security === null) {
      skipImpact(impact, MOMENTUM_CANDIDATE_DISCOVERY_SKIP_REASONS.UNKNOWN_SECURITY);
      continue;
    }

    if (impact.security.momentumUniverseMember === null) {
      skipImpact(
        impact,
        MOMENTUM_CANDIDATE_DISCOVERY_SKIP_REASONS.OUTSIDE_RESEARCH_UNIVERSE
      );
      continue;
    }

    if (!impact.security.momentumUniverseMember.enabled) {
      skipImpact(impact, MOMENTUM_CANDIDATE_DISCOVERY_SKIP_REASONS.UNIVERSE_DISABLED);
      continue;
    }

    if (activeSecurityIds.has(impact.security.id)) {
      skipImpact(
        impact,
        MOMENTUM_CANDIDATE_DISCOVERY_SKIP_REASONS.DUPLICATE_ACTIVE_CANDIDATE
      );
      continue;
    }

    const scores = {
      catalystScore: impact.totalCatalystScore,
      priceActionScore: 0,
      volumeScore: 0,
      riskScore: 0,
      totalScore: impact.totalCatalystScore,
    };
    const reason = buildCandidateReason(impact);
    const rawSnapshot = buildRawSnapshot({
      ...impact,
      symbol,
    });
    const metadata = {
      generatedBy: 'momentum_candidate_phase_3',
      priceVolumeConfirmation: 'deferred',
    } satisfies Prisma.InputJsonValue;

    const candidate = await prisma.momentumCandidate.upsert({
      where: {
        symbol_catalystImpactId: {
          symbol,
          catalystImpactId: impact.id,
        },
      },
      create: {
        securityId: impact.security.id,
        symbol,
        state: MomentumCandidateState.DISCOVERED,
        catalystEventId: impact.catalystEventId,
        catalystImpactId: impact.id,
        ...scores,
        reason,
        blockedReason: null,
        discoveredAt: now,
        lastEvaluatedAt: now,
        expiresAt,
        rawSnapshot,
        metadata,
      },
      update: {
        securityId: impact.security.id,
        catalystEventId: impact.catalystEventId,
        ...scores,
        reason,
        lastEvaluatedAt: now,
        rawSnapshot,
        metadata,
      },
    });

    candidates.push(candidate);
    activeSecurityIds.add(impact.security.id);
  }

  return {
    evaluatedImpacts: impacts.length,
    generatedCandidates: candidates.length,
    skippedCandidates: skippedImpacts.length,
    skipCounts,
    skippedImpacts,
    minCatalystScore,
    recentSince,
    expiresAt,
    candidates,
  };
}
