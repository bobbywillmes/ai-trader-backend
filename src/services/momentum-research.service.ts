import {
  MomentumCandidateState,
  MomentumScannerHandoffStatus,
  Prisma,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { serializeMomentumCandidatePriceCheck } from '../serializers/momentum-candidate-price-check.serializer.js';
import type {
  MomentumResearchCandidatesQuery,
  MomentumResearchCatalystsQuery,
} from '../validators/momentum-research.schema.js';

export const MOMENTUM_RESEARCH_RECENT_HOURS = 24;
export const MOMENTUM_RESEARCH_ACTIVE_STATES = [
  MomentumCandidateState.DISCOVERED,
  MomentumCandidateState.WATCHING,
  MomentumCandidateState.ENTRY_READY,
  MomentumCandidateState.ENTRY_BLOCKED,
] as const;

const candidateResearchInclude = {
  catalystEvent: {
    select: {
      id: true,
      title: true,
      source: true,
      sourcePublisher: true,
      sourceUrl: true,
      publishedAt: true,
      eventType: true,
      eventTier: true,
      sentiment: true,
    },
  },
  catalystImpact: {
    select: {
      id: true,
      catalystRole: true,
      sentiment: true,
      sentimentReasoning: true,
      totalCatalystScore: true,
    },
  },
  priceChecks: {
    orderBy: { observedAt: 'desc' as const },
    take: 1,
  },
  scannerHandoffs: {
    orderBy: { preparedAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      status: true,
      preparedAt: true,
    },
  },
} satisfies Prisma.MomentumCandidateInclude;

type CandidateResearchRecord = Prisma.MomentumCandidateGetPayload<{
  include: typeof candidateResearchInclude;
}>;

function pagination(page: number, pageSize: number, total: number) {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function activityAt(candidate: Pick<CandidateResearchRecord, 'lastEvaluatedAt' | 'updatedAt'>) {
  return candidate.lastEvaluatedAt ?? candidate.updatedAt;
}

async function loadSymbolContext(symbols: string[]) {
  if (symbols.length === 0) return new Map<string, unknown>();

  const securities = await prisma.security.findMany({
    where: { symbol: { in: symbols } },
    select: {
      id: true,
      symbol: true,
      name: true,
      assetType: true,
      enabled: true,
      momentumUniverseMember: {
        select: {
          id: true,
          enabled: true,
          newsEnabled: true,
          priceScanningEnabled: true,
        },
      },
      subscriptions: {
        select: { enabled: true },
      },
    },
  });

  return new Map(
    securities.map((security) => [
      security.symbol,
      {
        security: {
          id: security.id,
          symbol: security.symbol,
          name: security.name,
          assetType: security.assetType,
          enabled: security.enabled,
        },
        universe: security.momentumUniverseMember,
        tradingAvailability: {
          subscriptionCount: security.subscriptions.length,
          enabledSubscriptionCount: security.subscriptions.filter((item) => item.enabled).length,
        },
      },
    ])
  );
}

function serializeCandidate(
  candidate: CandidateResearchRecord,
  context: unknown
) {
  const latestPriceCheck = candidate.priceChecks[0] ?? null;
  const latestHandoff = candidate.scannerHandoffs[0] ?? null;

  return {
    id: candidate.id,
    symbol: candidate.symbol,
    state: candidate.state,
    scores: {
      catalyst: candidate.catalystScore,
      priceAction: candidate.priceActionScore,
      volume: candidate.volumeScore,
      risk: candidate.riskScore,
      total: candidate.totalScore,
    },
    reason: candidate.reason,
    blockedReason: candidate.blockedReason,
    discoveredAt: candidate.discoveredAt,
    lastEvaluatedAt: candidate.lastEvaluatedAt,
    updatedAt: candidate.updatedAt,
    activityAt: activityAt(candidate),
    expiresAt: candidate.expiresAt,
    entryReady: candidate.state === MomentumCandidateState.ENTRY_READY,
    blocked: candidate.state === MomentumCandidateState.ENTRY_BLOCKED,
    catalyst: candidate.catalystEvent,
    catalystImpact: candidate.catalystImpact,
    latestPriceCheck: serializeMomentumCandidatePriceCheck(latestPriceCheck),
    latestHandoff,
    ...(context && typeof context === 'object' ? context : {
      security: null,
      universe: null,
      tradingAvailability: { subscriptionCount: 0, enabledSubscriptionCount: 0 },
    }),
  };
}

function candidateWhere(query: MomentumResearchCandidatesQuery) {
  const where: Prisma.MomentumCandidateWhereInput = {};

  if (query.search) {
    where.symbol = { contains: query.search.toUpperCase(), mode: 'insensitive' };
  }
  if (query.state) where.state = query.state;
  if (query.minTotalScore !== undefined) where.totalScore = { gte: query.minTotalScore };
  if (query.catalystType) where.catalystEvent = { eventType: query.catalystType };
  if (query.entryReady !== undefined) {
    where.state = query.entryReady
      ? MomentumCandidateState.ENTRY_READY
      : { not: MomentumCandidateState.ENTRY_READY };
  }
  if (query.blocked !== undefined) {
    where.state = query.blocked
      ? MomentumCandidateState.ENTRY_BLOCKED
      : { not: MomentumCandidateState.ENTRY_BLOCKED };
  }
  if (query.from || query.to) {
    where.discoveredAt = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }

  return where;
}

function candidateOrderBy(query: MomentumResearchCandidatesQuery) {
  const direction = query.sortDirection;
  if (query.sortBy === 'lastEvaluatedAt') {
    return [{ lastEvaluatedAt: { sort: direction, nulls: 'last' as const } }, { updatedAt: direction }];
  }
  return [{ [query.sortBy]: direction }, { id: 'asc' as const }];
}

export async function listMomentumResearchCandidates(query: MomentumResearchCandidatesQuery) {
  const where = candidateWhere(query);
  const [rows, total] = await prisma.$transaction([
    prisma.momentumCandidate.findMany({
      where,
      include: candidateResearchInclude,
      orderBy: candidateOrderBy(query),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.momentumCandidate.count({ where }),
  ]);
  const context = await loadSymbolContext([...new Set(rows.map((row) => row.symbol))]);

  return {
    data: rows.map((row) => serializeCandidate(row, context.get(row.symbol))),
    pagination: pagination(query.page, query.pageSize, total),
  };
}

function catalystWhere(query: MomentumResearchCatalystsQuery) {
  const where: Prisma.CatalystEventWhereInput = {};
  if (query.search) {
    where.OR = [
      { title: { contains: query.search, mode: 'insensitive' } },
      { tickerImpacts: { some: { symbol: { contains: query.search.toUpperCase(), mode: 'insensitive' } } } },
    ];
  }
  if (query.publisher) where.sourcePublisher = { contains: query.publisher, mode: 'insensitive' };
  if (query.source) where.source = query.source;
  if (query.catalystType) where.eventType = query.catalystType;
  if (query.tier) where.eventTier = query.tier;
  if (query.sentiment) where.sentiment = query.sentiment;
  if (query.from || query.to) {
    where.publishedAt = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }
  return where;
}

export async function listMomentumResearchCatalysts(query: MomentumResearchCatalystsQuery) {
  const where = catalystWhere(query);
  const [rows, total] = await prisma.$transaction([
    prisma.catalystEvent.findMany({
      where,
      orderBy: [
        query.sortBy === 'publishedAt'
          ? { publishedAt: { sort: query.sortDirection, nulls: 'last' } }
          : { [query.sortBy]: query.sortDirection },
        { id: 'asc' },
      ],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        title: true,
        source: true,
        sourceUrl: true,
        sourcePublisher: true,
        publishedAt: true,
        receivedAt: true,
        eventType: true,
        eventTier: true,
        sentiment: true,
        tickerImpacts: {
          orderBy: [{ totalCatalystScore: 'desc' }, { symbol: 'asc' }],
          select: {
            id: true,
            symbol: true,
            catalystRole: true,
            sentiment: true,
            totalCatalystScore: true,
          },
        },
        momentumCandidates: {
          select: { id: true, symbol: true, state: true },
          orderBy: { discoveredAt: 'desc' },
        },
      },
    }),
    prisma.catalystEvent.count({ where }),
  ]);

  return {
    data: rows.map((row) => ({
      ...row,
      impactedSymbols: row.tickerImpacts.map((impact) => impact.symbol),
      candidateCount: row.momentumCandidates.length,
    })),
    pagination: pagination(query.page, query.pageSize, total),
  };
}

export async function getMomentumResearchOverview(now = new Date()) {
  const recentSince = new Date(now.getTime() - MOMENTUM_RESEARCH_RECENT_HOURS * 60 * 60 * 1000);
  const activeWhere = { state: { in: [...MOMENTUM_RESEARCH_ACTIVE_STATES] } };
  const [
    activeCandidates,
    entryReadyCandidates,
    blockedCandidates,
    recentCatalysts,
    preparedHandoffs,
    enabledUniverseMembers,
    topRows,
    recentCatalystRows,
    recentCandidateRows,
    cursors,
    lastCandidate,
    lastPriceCheck,
  ] = await prisma.$transaction([
    prisma.momentumCandidate.count({ where: activeWhere }),
    prisma.momentumCandidate.count({ where: { state: MomentumCandidateState.ENTRY_READY } }),
    prisma.momentumCandidate.count({ where: { state: MomentumCandidateState.ENTRY_BLOCKED } }),
    prisma.catalystEvent.count({ where: { receivedAt: { gte: recentSince } } }),
    prisma.momentumScannerHandoff.count({
      where: {
        status: { in: [
          MomentumScannerHandoffStatus.PENDING,
          MomentumScannerHandoffStatus.SENT,
          MomentumScannerHandoffStatus.ACKNOWLEDGED,
        ] },
      },
    }),
    prisma.momentumUniverseMember.count({ where: { enabled: true } }),
    prisma.momentumCandidate.findMany({
      where: activeWhere,
      include: candidateResearchInclude,
      orderBy: [{ totalScore: 'desc' }, { lastEvaluatedAt: { sort: 'desc', nulls: 'last' } }],
      take: 10,
    }),
    prisma.catalystEvent.findMany({
      where: { receivedAt: { gte: recentSince } },
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { receivedAt: 'desc' }],
      take: 10,
      select: {
        id: true, title: true, source: true, sourceUrl: true, sourcePublisher: true,
        publishedAt: true, receivedAt: true, eventType: true, eventTier: true, sentiment: true,
        tickerImpacts: { select: { symbol: true }, orderBy: { symbol: 'asc' } },
        momentumCandidates: { select: { id: true, symbol: true, state: true } },
      },
    }),
    prisma.momentumCandidate.findMany({
      where: { OR: [{ lastEvaluatedAt: { gte: recentSince } }, { updatedAt: { gte: recentSince } }] },
      include: candidateResearchInclude,
      orderBy: [{ lastEvaluatedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
      take: 10,
    }),
    prisma.newsPullCursor.findMany({
      where: { enabled: true },
      select: { lastPulledAt: true, pullIntervalMin: true, consecutiveErrors: true },
    }),
    prisma.momentumCandidate.findFirst({ orderBy: { lastEvaluatedAt: { sort: 'desc', nulls: 'last' } }, select: { lastEvaluatedAt: true } }),
    prisma.momentumCandidatePriceCheck.findFirst({ orderBy: { observedAt: 'desc' }, select: { observedAt: true } }),
  ]);
  const symbols = [...new Set([...topRows, ...recentCandidateRows].map((row) => row.symbol))];
  const context = await loadSymbolContext(symbols);
  const lastNewsPullAt = cursors.reduce<Date | null>(
    (latest, cursor) => !cursor.lastPulledAt || (latest && latest >= cursor.lastPulledAt) ? latest : cursor.lastPulledAt,
    null
  );

  return {
    windows: {
      recentCatalystsSince: recentSince,
      recentCandidateActivitySince: recentSince,
      asOf: now,
    },
    summary: {
      activeCandidates,
      entryReadyCandidates,
      blockedCandidates,
      recentCatalysts,
      preparedHandoffs,
      enabledUniverseMembers,
    },
    topCandidates: topRows.map((row) => serializeCandidate(row, context.get(row.symbol))),
    recentCatalysts: recentCatalystRows.map((row) => ({
      ...row,
      impactedSymbols: row.tickerImpacts.map((impact) => impact.symbol),
      candidateCount: row.momentumCandidates.length,
    })),
    recentCandidateActivity: recentCandidateRows.map((row) => serializeCandidate(row, context.get(row.symbol))),
    scannerHealth: {
      enabledCursorCount: cursors.length,
      healthyCursorCount: cursors.filter((cursor) => cursor.consecutiveErrors === 0).length,
      errorCursorCount: cursors.filter((cursor) => cursor.consecutiveErrors > 0).length,
      dueCursorCount: cursors.filter((cursor) => !cursor.lastPulledAt || cursor.lastPulledAt.getTime() + cursor.pullIntervalMin * 60_000 <= now.getTime()).length,
      lastNewsPullAt,
      lastCandidateGenerationActivityAt: lastCandidate?.lastEvaluatedAt ?? null,
      lastPriceConfirmationActivityAt: lastPriceCheck?.observedAt ?? null,
    },
  };
}
