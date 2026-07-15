import {
  CatalystSentiment,
  CatalystTickerRole,
  MomentumCandidateState,
  Prisma,
  type MomentumCandidate,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
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

export type ExpireStaleMomentumCandidatesArgs = {
  now?: Date;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_MIN_CATALYST_SCORE = 60;
const DEFAULT_RECENT_LOOKBACK_HOURS = 24;
const DEFAULT_EXPIRES_IN_HOURS = 24;
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
    take: args.take ?? MAX_LIMIT,
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
    },
  });

  const candidates: MomentumCandidate[] = [];

  for (const impact of impacts) {
    const symbol = normalizeSymbol(impact.symbol);

    if (!symbol) {
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
        catalystEventId: impact.catalystEventId,
        ...scores,
        reason,
        lastEvaluatedAt: now,
        expiresAt,
        rawSnapshot,
        metadata,
      },
    });

    candidates.push(candidate);
  }

  return {
    evaluatedImpacts: impacts.length,
    generatedCandidates: candidates.length,
    minCatalystScore,
    recentSince,
    expiresAt,
    candidates,
  };
}

export async function expireStaleMomentumCandidates(
  args: ExpireStaleMomentumCandidatesArgs = {}
) {
  const now = args.now ?? new Date();
  const result = await prisma.momentumCandidate.updateMany({
    where: {
      state: {
        in: [...ACTIVE_MOMENTUM_CANDIDATE_STATES],
      },
      expiresAt: {
        lte: now,
      },
    },
    data: {
      state: MomentumCandidateState.EXPIRED,
      lastEvaluatedAt: now,
    },
  });

  return {
    expired: result.count,
    asOf: now,
  };
}
