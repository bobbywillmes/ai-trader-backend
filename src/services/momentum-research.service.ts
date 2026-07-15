import {
  MomentumCandidateState,
  MomentumScannerHandoffStatus,
  Prisma,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { serializeMomentumCandidatePriceCheck } from '../serializers/momentum-candidate-price-check.serializer.js';
import { ACTIVE_MOMENTUM_CANDIDATE_STATES } from './momentum-candidate-lifecycle.js';
import {
  evaluateMomentumHandoffEligibility,
  evaluateMomentumPriceConfirmationEligibility,
} from './momentum-candidate-eligibility.service.js';
import {
  evaluateMomentumSubscriptionEligibility,
  momentumSubscriptionEligibilitySelect,
} from './momentum-subscription-eligibility.service.js';
import type {
  MomentumResearchCandidatesQuery,
  MomentumResearchCatalystsQuery,
} from '../validators/momentum-research.schema.js';

export const MOMENTUM_RESEARCH_RECENT_HOURS = 24;
export const MOMENTUM_RESEARCH_ACTIVE_STATES = ACTIVE_MOMENTUM_CANDIDATE_STATES;

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
        select: momentumSubscriptionEligibilitySelect,
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
        subscriptions: security.subscriptions,
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

  const candidateContext = context && typeof context === 'object'
    ? context as {
        security: { id: number } | null;
        universe: { enabled: boolean; priceScanningEnabled: boolean } | null;
        subscriptions: Parameters<typeof evaluateMomentumSubscriptionEligibility>[0];
      }
    : null;
  const eligibilityInput = {
    state: candidate.state,
    expiresAt: candidate.expiresAt,
    blockedReason: candidate.blockedReason,
    latestPriceCheck,
    security: candidateContext?.security ? {
      id: candidateContext.security.id,
      momentumUniverseMember: candidateContext.universe,
      subscriptions: candidateContext.subscriptions,
    } : null,
  };
  const priceEligibility = evaluateMomentumPriceConfirmationEligibility(eligibilityInput);
  const handoffEligibility = evaluateMomentumHandoffEligibility(eligibilityInput);

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
    eligibility: {
      momentumSubscriptionEligibility: priceEligibility.momentumSubscriptionEligibility,
      priceConfirmationEligible: priceEligibility.eligible,
      handoffEligible: handoffEligibility.eligible,
      priceConfirmationReasons: priceEligibility.reasons,
      handoffReasons: handoffEligibility.reasons,
    },
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
  const [eligibilitySecurities, diagnosticCandidates] = await Promise.all([
    prisma.security.findMany({
      where: {
        OR: [
          { momentumUniverseMember: { isNot: null } },
          { subscriptions: { some: { enabled: true } } },
        ],
      },
      select: {
        id: true,
        momentumUniverseMember: {
          select: { enabled: true, newsEnabled: true, priceScanningEnabled: true },
        },
        subscriptions: { select: momentumSubscriptionEligibilitySelect },
      },
      orderBy: { id: 'asc' },
      take: 1001,
    }),
    prisma.momentumCandidate.findMany({
      where: activeWhere,
      select: {
        id: true,
        state: true,
        expiresAt: true,
        blockedReason: true,
        security: {
          select: {
            id: true,
            momentumUniverseMember: {
              select: { enabled: true, priceScanningEnabled: true },
            },
            subscriptions: { select: momentumSubscriptionEligibilitySelect },
          },
        },
        priceChecks: {
          select: { confirmed: true },
          orderBy: { observedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { id: 'asc' },
      take: 1001,
    }),
  ]);
  const boundedSecurities = eligibilitySecurities.slice(0, 1000);
  const boundedCandidates = diagnosticCandidates.slice(0, 1000);
  const securityDiagnostics = boundedSecurities.map((security) => ({
    ...security,
    subscriptionEligibility: evaluateMomentumSubscriptionEligibility(security.subscriptions),
  }));
  const candidateDiagnostics = boundedCandidates.map((candidate) => {
    const candidateContext = {
      ...candidate,
      latestPriceCheck: candidate.priceChecks[0] ?? null,
    };
    return {
      candidate,
      price: evaluateMomentumPriceConfirmationEligibility(candidateContext, now),
      handoff: evaluateMomentumHandoffEligibility(candidateContext, now),
    };
  });
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
    eligibilitySummary: {
      universeMembersEnabled: securityDiagnostics.filter((item) => item.momentumUniverseMember?.enabled).length,
      universeMembersWithActiveMomentumSubscriptions: securityDiagnostics.filter(
        (item) => item.momentumUniverseMember?.enabled && item.subscriptionEligibility.eligible
      ).length,
      researchOnlyMembers: securityDiagnostics.filter(
        (item) => item.momentumUniverseMember?.enabled && !item.subscriptionEligibility.eligible
      ).length,
      enabledMomentumSubscriptionsOutsideUniverse: securityDiagnostics.filter(
        (item) => item.momentumUniverseMember === null && item.subscriptionEligibility.eligible
      ).length,
      activeCandidatesOutsideUniverse: candidateDiagnostics.filter(
        ({ candidate }) => candidate.security?.momentumUniverseMember === null
      ).length,
      activeCandidatesWithoutValidSecurities: candidateDiagnostics.filter(
        ({ candidate }) => candidate.security === null
      ).length,
      activeCandidatesWithoutMomentumSubscriptions: candidateDiagnostics.filter(
        ({ price }) => !price.momentumSubscriptionEligibility.eligible
      ).length,
      priceConfirmationEligibleCandidates: candidateDiagnostics.filter(({ price }) => price.eligible).length,
      handoffEligibleCandidates: candidateDiagnostics.filter(({ handoff }) => handoff.eligible).length,
      staleCandidatesAwaitingExpiration: candidateDiagnostics.filter(
        ({ price }) => price.reasons.includes('CANDIDATE_EXPIRED')
      ).length,
      bounded: {
        limit: 1000,
        securitiesTruncated: eligibilitySecurities.length > 1000,
        candidatesTruncated: diagnosticCandidates.length > 1000,
      },
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

const candidateDetailInclude = {
  catalystEvent: {
    select: {
      id: true,
      source: true,
      sourceExternalId: true,
      sourceUrl: true,
      sourcePublisher: true,
      sourceAuthor: true,
      title: true,
      summary: true,
      bodyExcerpt: true,
      language: true,
      publishedAt: true,
      receivedAt: true,
      eventType: true,
      eventTier: true,
      sentiment: true,
      confidence: true,
      isDuplicate: true,
      duplicateOfId: true,
      createdAt: true,
      updatedAt: true,
      tickerImpacts: {
        orderBy: [{ totalCatalystScore: 'desc' as const }, { symbol: 'asc' as const }],
        select: {
          id: true,
          symbol: true,
          sentiment: true,
          sentimentReasoning: true,
          relevanceScore: true,
          actionabilityScore: true,
          freshnessScore: true,
          sourceQualityScore: true,
          totalCatalystScore: true,
          isPrimaryTicker: true,
          isCompanySpecific: true,
          isMarketWide: true,
          isSectorWide: true,
          catalystRole: true,
          blockedReason: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  },
  catalystImpact: {
    select: {
      id: true,
      symbol: true,
      sentiment: true,
      sentimentReasoning: true,
      relevanceScore: true,
      actionabilityScore: true,
      freshnessScore: true,
      sourceQualityScore: true,
      totalCatalystScore: true,
      isPrimaryTicker: true,
      isCompanySpecific: true,
      isMarketWide: true,
      isSectorWide: true,
      catalystRole: true,
      blockedReason: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  priceChecks: {
    orderBy: { observedAt: 'asc' as const },
  },
  scannerHandoffs: {
    orderBy: { preparedAt: 'asc' as const },
    select: {
      id: true,
      symbol: true,
      status: true,
      payloadVersion: true,
      preparedAt: true,
      sentAt: true,
      acknowledgedAt: true,
      failedAt: true,
      attempts: true,
      lastError: true,
      idempotencyKey: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.MomentumCandidateInclude;

const researchSecuritySelect = {
  id: true,
  symbol: true,
  name: true,
  assetType: true,
  enabled: true,
  sector: true,
  industry: true,
  momentumUniverseMember: true,
  subscriptions: {
    orderBy: { name: 'asc' as const },
    select: {
      id: true,
      key: true,
      name: true,
      symbol: true,
      broker: true,
      brokerMode: true,
      enabled: true,
      strategy: { select: { id: true, key: true, name: true, enabled: true } },
      exitProfile: { select: { id: true, key: true, name: true, enabled: true } },
      tradingAccount: {
        select: {
          id: true,
          displayName: true,
          broker: true,
          environment: true,
          status: true,
          tradingEnabled: true,
        },
      },
      accountSubscriptions: momentumSubscriptionEligibilitySelect.accountSubscriptions,
    },
  },
  trackedPositions: {
    where: { status: { in: ['open', 'closing'], mode: 'insensitive' as const } },
    orderBy: { openedAt: 'desc' as const },
    select: {
      id: true,
      broker: true,
      symbol: true,
      side: true,
      qty: true,
      avgEntryPrice: true,
      currentPrice: true,
      marketValue: true,
      unrealizedPnL: true,
      unrealizedPnLPct: true,
      status: true,
      openedAt: true,
      lastSyncedAt: true,
      subscriptionId: true,
      tradingAccountId: true,
    },
  },
} satisfies Prisma.SecuritySelect;

async function getResearchSecurity(symbol: string) {
  return prisma.security.findUnique({
    where: { symbol },
    select: researchSecuritySelect,
  });
}

async function getSymbolCursors(symbol: string) {
  return prisma.newsPullCursor.findMany({
    where: { symbol },
    orderBy: { source: 'asc' },
    select: {
      id: true,
      source: true,
      enabled: true,
      priority: true,
      pullIntervalMin: true,
      lastPulledAt: true,
      lastPublishedAt: true,
      consecutiveErrors: true,
      lastError: true,
      updatedAt: true,
    },
  });
}

function cursorHealth(cursors: Awaited<ReturnType<typeof getSymbolCursors>>) {
  if (cursors.length === 0) return null;
  if (cursors.some((cursor) => cursor.consecutiveErrors > 0)) return 'ERROR';
  if (cursors.some((cursor) => cursor.enabled)) return 'HEALTHY';
  return 'DISABLED';
}

function serializeFullCandidate<T extends {
  priceChecks: Array<Parameters<typeof serializeMomentumCandidatePriceCheck>[0]>;
}>(candidate: T) {
  return {
    ...candidate,
    priceChecks: candidate.priceChecks.map(serializeMomentumCandidatePriceCheck),
  };
}

export async function getMomentumResearchCandidate(candidateId: string) {
  const candidate = await prisma.momentumCandidate.findUnique({
    where: { id: candidateId },
    include: candidateDetailInclude,
  });

  if (!candidate) throw new HttpError(404, 'Momentum candidate not found.');

  const [security, cursors] = await Promise.all([
    getResearchSecurity(candidate.symbol),
    getSymbolCursors(candidate.symbol),
  ]);

  return {
    candidate: serializeFullCandidate(candidate),
    security: security
      ? {
          id: security.id,
          symbol: security.symbol,
          name: security.name,
          assetType: security.assetType,
          enabled: security.enabled,
          sector: security.sector,
          industry: security.industry,
        }
      : null,
    universeMembership: security?.momentumUniverseMember ?? null,
    subscriptions: security?.subscriptions ?? [],
    tradingContext: {
      hasEnabledSubscription: security?.subscriptions.some((item) => item.enabled) ?? false,
      openPositions: security?.trackedPositions ?? [],
    },
    newsCursors: cursors,
    cursorHealth: cursorHealth(cursors),
  };
}

export async function getMomentumSymbolResearch(symbol: string) {
  const security = await getResearchSecurity(symbol);
  if (!security) throw new HttpError(404, 'Security not found.');

  const activeWhere: Prisma.MomentumCandidateWhereInput = {
    symbol,
    state: { in: [...MOMENTUM_RESEARCH_ACTIVE_STATES] },
  };
  const [cursors, currentCandidate, recentCandidates, recentCatalysts] = await Promise.all([
    getSymbolCursors(symbol),
    prisma.momentumCandidate.findFirst({
      where: activeWhere,
      include: candidateDetailInclude,
      orderBy: [
        { lastEvaluatedAt: { sort: 'desc', nulls: 'last' } },
        { updatedAt: 'desc' },
      ],
    }),
    prisma.momentumCandidate.findMany({
      where: { symbol },
      include: candidateDetailInclude,
      orderBy: [{ discoveredAt: 'desc' }, { id: 'asc' }],
      take: 25,
    }),
    prisma.catalystEvent.findMany({
      where: { tickerImpacts: { some: { symbol } } },
      orderBy: [
        { publishedAt: { sort: 'desc', nulls: 'last' } },
        { receivedAt: 'desc' },
      ],
      take: 50,
      select: {
        id: true,
        source: true,
        sourceUrl: true,
        sourcePublisher: true,
        title: true,
        summary: true,
        publishedAt: true,
        receivedAt: true,
        eventType: true,
        eventTier: true,
        sentiment: true,
        confidence: true,
        createdAt: true,
        updatedAt: true,
        tickerImpacts: {
          where: { symbol },
          orderBy: { totalCatalystScore: 'desc' },
        },
        momentumCandidates: {
          where: { symbol },
          select: { id: true, state: true, totalScore: true, discoveredAt: true },
          orderBy: { discoveredAt: 'desc' },
        },
      },
    }),
  ]);
  const serializedCandidates = recentCandidates.map(serializeFullCandidate);
  const momentumSubscriptionEligibility = evaluateMomentumSubscriptionEligibility(
    security.subscriptions
  );
  const researchReasons = [
    ...(security.momentumUniverseMember === null ? ['OUTSIDE_RESEARCH_UNIVERSE'] : []),
    ...(security.momentumUniverseMember !== null && !security.momentumUniverseMember.enabled ? ['UNIVERSE_DISABLED'] : []),
    ...(security.momentumUniverseMember !== null && !security.momentumUniverseMember.newsEnabled ? ['NEWS_DISABLED'] : []),
  ];
  const candidateContext = currentCandidate
    ? {
        state: currentCandidate.state,
        expiresAt: currentCandidate.expiresAt,
        blockedReason: currentCandidate.blockedReason,
        latestPriceCheck: currentCandidate.priceChecks.at(-1) ?? null,
        security: {
          id: security.id,
          momentumUniverseMember: security.momentumUniverseMember,
          subscriptions: security.subscriptions,
        },
      }
    : null;
  const priceConfirmationEligibility = candidateContext
    ? evaluateMomentumPriceConfirmationEligibility(candidateContext)
    : { eligible: false, reasons: ['NO_ACTIVE_CANDIDATE'], momentumSubscriptionEligibility };
  const handoffEligibility = candidateContext
    ? evaluateMomentumHandoffEligibility(candidateContext)
    : { eligible: false, reasons: ['NO_ACTIVE_CANDIDATE'], momentumSubscriptionEligibility };

  return {
    security: {
      id: security.id,
      symbol: security.symbol,
      name: security.name,
      assetType: security.assetType,
      enabled: security.enabled,
      sector: security.sector,
      industry: security.industry,
    },
    researchStatus: {
      universeMember: security.momentumUniverseMember !== null,
      universeEnabled: security.momentumUniverseMember?.enabled ?? false,
      newsEnabled: security.momentumUniverseMember?.newsEnabled ?? false,
      priceScanningEnabled: security.momentumUniverseMember?.priceScanningEnabled ?? false,
      cursorHealth: cursorHealth(cursors),
      lastNewsPullAt: cursors.reduce<Date | null>(
        (latest, cursor) => !cursor.lastPulledAt || (latest && latest >= cursor.lastPulledAt) ? latest : cursor.lastPulledAt,
        null
      ),
      universeMembership: security.momentumUniverseMember,
      newsCursors: cursors,
    },
    eligibility: {
      researchEligibility: {
        eligible: researchReasons.length === 0,
        inUniverse: security.momentumUniverseMember !== null,
        universeEnabled: security.momentumUniverseMember?.enabled ?? false,
        newsEnabled: security.momentumUniverseMember?.newsEnabled ?? false,
        priceScanningEnabled: security.momentumUniverseMember?.priceScanningEnabled ?? false,
        reasons: researchReasons.length > 0 ? researchReasons : ['ELIGIBLE'],
      },
      momentumSubscriptionEligibility,
      candidateEligibility: {
        discoveryEligible: security.momentumUniverseMember?.enabled === true,
        priceConfirmationEligible: priceConfirmationEligibility.eligible,
        handoffEligible: handoffEligibility.eligible,
        priceConfirmationReasons: priceConfirmationEligibility.reasons,
        handoffReasons: handoffEligibility.reasons,
      },
    },
    tradingContext: {
      subscriptions: security.subscriptions,
      hasEnabledSubscription: security.subscriptions.some((item) => item.enabled),
      openPositions: security.trackedPositions,
      hasOpenPosition: security.trackedPositions.length > 0,
    },
    currentCandidate: currentCandidate ? serializeFullCandidate(currentCandidate) : null,
    recentCandidates: serializedCandidates,
    recentCatalysts,
    priceChecks: serializedCandidates.flatMap((candidate) => candidate.priceChecks),
    handoffs: serializedCandidates.flatMap((candidate) => candidate.scannerHandoffs),
  };
}
