import {
  CatalystEventType, CatalystSentiment, CatalystSource, CatalystTier,
  MomentumCandidateState,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn((operations: Array<Promise<unknown>>) => Promise.all(operations)),
  candidateCount: vi.fn(), candidateFindMany: vi.fn(), candidateFindFirst: vi.fn(), candidateFindUnique: vi.fn(),
  catalystCount: vi.fn(), catalystFindMany: vi.fn(), handoffCount: vi.fn(),
  universeCount: vi.fn(), securityFindMany: vi.fn(), securityFindUnique: vi.fn(), cursorFindMany: vi.fn(),
  priceCheckFindFirst: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    momentumCandidate: { count: mocks.candidateCount, findMany: mocks.candidateFindMany, findFirst: mocks.candidateFindFirst, findUnique: mocks.candidateFindUnique },
    catalystEvent: { count: mocks.catalystCount, findMany: mocks.catalystFindMany },
    momentumScannerHandoff: { count: mocks.handoffCount },
    momentumUniverseMember: { count: mocks.universeCount },
    security: { findMany: mocks.securityFindMany, findUnique: mocks.securityFindUnique },
    newsPullCursor: { findMany: mocks.cursorFindMany },
    momentumCandidatePriceCheck: { findFirst: mocks.priceCheckFindFirst },
  },
}));

import { getMomentumResearchCandidate, getMomentumResearchOverview, getMomentumSymbolResearch, listMomentumResearchCandidates, listMomentumResearchCatalysts } from './momentum-research.service.js';

const now = new Date('2026-07-10T18:00:00.000Z');

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'candidate-1', symbol: 'AAPL', state: MomentumCandidateState.WATCHING,
    catalystEventId: 'event-1', catalystImpactId: 'impact-1', catalystScore: 70,
    priceActionScore: 10, volumeScore: 8, riskScore: 7, totalScore: 95,
    reason: 'Stored candidate reason.', blockedReason: null,
    discoveredAt: new Date('2026-07-10T12:00:00.000Z'),
    lastEvaluatedAt: new Date('2026-07-10T17:00:00.000Z'),
    expiresAt: new Date('2026-07-11T12:00:00.000Z'), rawSnapshot: null, metadata: null,
    createdAt: new Date('2026-07-10T12:00:00.000Z'), updatedAt: new Date('2026-07-10T17:00:00.000Z'),
    catalystEvent: {
      id: 'event-1', title: 'Apple catalyst', source: CatalystSource.MASSIVE_NEWS,
      sourcePublisher: 'Newswire', sourceUrl: 'https://example.test/apple',
      publishedAt: new Date('2026-07-10T11:00:00.000Z'), eventType: CatalystEventType.PARTNERSHIP,
      eventTier: CatalystTier.HIGH, sentiment: CatalystSentiment.POSITIVE,
    },
    catalystImpact: { id: 'impact-1', catalystRole: 'PRIMARY_SUBJECT', sentiment: CatalystSentiment.POSITIVE, sentimentReasoning: 'Direct positive impact.', totalCatalystScore: 70 },
    priceChecks: [], scannerHandoffs: [], ...overrides,
  };
}

describe('momentum research service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation((operations) => Promise.all(operations));
    mocks.candidateCount.mockResolvedValue(0); mocks.candidateFindMany.mockResolvedValue([]);
    mocks.candidateFindFirst.mockResolvedValue(null); mocks.candidateFindUnique.mockResolvedValue(null); mocks.catalystCount.mockResolvedValue(0);
    mocks.catalystFindMany.mockResolvedValue([]); mocks.handoffCount.mockResolvedValue(0);
    mocks.universeCount.mockResolvedValue(0); mocks.securityFindMany.mockResolvedValue([]); mocks.securityFindUnique.mockResolvedValue(null);
    mocks.cursorFindMany.mockResolvedValue([]); mocks.priceCheckFindFirst.mockResolvedValue(null);
  });

  it('uses scanner active states and explicit 24-hour overview windows', async () => {
    mocks.candidateCount.mockResolvedValueOnce(4).mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    mocks.catalystCount.mockResolvedValue(3); mocks.handoffCount.mockResolvedValue(2); mocks.universeCount.mockResolvedValue(8);
    await expect(getMomentumResearchOverview(now)).resolves.toMatchObject({
      windows: { recentCatalystsSince: new Date('2026-07-09T18:00:00.000Z'), recentCandidateActivitySince: new Date('2026-07-09T18:00:00.000Z'), asOf: now },
      summary: { activeCandidates: 4, entryReadyCandidates: 1, blockedCandidates: 1, recentCatalysts: 3, preparedHandoffs: 2, enabledUniverseMembers: 8 },
    });
    expect(mocks.candidateCount).toHaveBeenNthCalledWith(1, { where: { state: { in: [MomentumCandidateState.DISCOVERED, MomentumCandidateState.WATCHING, MomentumCandidateState.ENTRY_READY, MomentumCandidateState.ENTRY_BLOCKED] } } });
    expect(mocks.catalystCount).toHaveBeenCalledWith({ where: { receivedAt: { gte: new Date('2026-07-09T18:00:00.000Z') } } });
  });

  it('derives scanner health from persisted cursor state', async () => {
    mocks.cursorFindMany.mockResolvedValue([
      { lastPulledAt: new Date('2026-07-10T17:50:00.000Z'), pullIntervalMin: 15, consecutiveErrors: 0 },
      { lastPulledAt: new Date('2026-07-10T16:00:00.000Z'), pullIntervalMin: 30, consecutiveErrors: 2 },
      { lastPulledAt: null, pullIntervalMin: 15, consecutiveErrors: 0 },
    ]);
    const result = await getMomentumResearchOverview(now);
    expect(result.scannerHealth).toMatchObject({ enabledCursorCount: 3, healthyCursorCount: 2, errorCursorCount: 1, dueCursorCount: 2, lastNewsPullAt: new Date('2026-07-10T17:50:00.000Z') });
  });

  it('returns bounded momentum eligibility mismatch diagnostics', async () => {
    const qualifyingSubscription = {
      id: 9, key: 'aapl-momentum', enabled: true,
      strategy: { id: 4, key: 'momentum_stock', enabled: true },
      accountSubscriptions: [{
        id: 11, enabled: true, entriesEnabled: true,
        tradingAccount: { id: 7, status: 'ACTIVE' },
        allocation: { id: 5, enabled: true },
      }],
    };
    mocks.securityFindMany.mockResolvedValue([
      { id: 1, momentumUniverseMember: { enabled: true, newsEnabled: true, priceScanningEnabled: true }, subscriptions: [qualifyingSubscription] },
      { id: 2, momentumUniverseMember: { enabled: true, newsEnabled: true, priceScanningEnabled: true }, subscriptions: [] },
      { id: 3, momentumUniverseMember: null, subscriptions: [qualifyingSubscription] },
    ]);
    mocks.candidateFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'eligible', state: MomentumCandidateState.WATCHING, expiresAt: new Date('2026-07-11T00:00:00.000Z'), blockedReason: null,
        security: { id: 1, momentumUniverseMember: { enabled: true, priceScanningEnabled: true }, subscriptions: [qualifyingSubscription] },
        priceChecks: [],
      }, {
        id: 'missing', state: MomentumCandidateState.WATCHING, expiresAt: new Date('2026-07-11T00:00:00.000Z'), blockedReason: null,
        security: null, priceChecks: [],
      }]);

    const result = await getMomentumResearchOverview(now);

    expect(result.eligibilitySummary).toMatchObject({
      universeMembersEnabled: 2,
      universeMembersWithActiveMomentumSubscriptions: 1,
      researchOnlyMembers: 1,
      enabledMomentumSubscriptionsOutsideUniverse: 1,
      activeCandidatesWithoutValidSecurities: 1,
      activeCandidatesWithoutMomentumSubscriptions: 1,
      priceConfirmationEligibleCandidates: 1,
      handoffEligibleCandidates: 0,
      bounded: { limit: 1000, securitiesTruncated: false, candidatesTruncated: false },
    });
    expect(mocks.securityFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1001 }));
  });

  it('paginates and filters candidates, then batch-loads symbol context', async () => {
    mocks.candidateFindMany.mockResolvedValue([candidate()]); mocks.candidateCount.mockResolvedValue(1);
    mocks.securityFindMany.mockResolvedValue([{ id: 1, symbol: 'AAPL', name: 'Apple Inc.', assetType: 'STOCK', enabled: true, momentumUniverseMember: { id: 'member-1', enabled: true, newsEnabled: true, priceScanningEnabled: true }, subscriptions: [{ id: 1, key: 'momentum', enabled: true, strategy: { id: 1, key: 'momentum_stock', enabled: true }, accountSubscriptions: [] }, { id: 2, key: 'disabled', enabled: false, strategy: { id: 1, key: 'momentum_stock', enabled: true }, accountSubscriptions: [] }] }]);
    const result = await listMomentumResearchCandidates({ page: 2, pageSize: 10, search: 'aap', minTotalScore: 80, catalystType: CatalystEventType.PARTNERSHIP, entryReady: true, sortBy: 'totalScore', sortDirection: 'desc' });
    expect(mocks.candidateFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { symbol: { contains: 'AAP', mode: 'insensitive' }, totalScore: { gte: 80 }, catalystEvent: { eventType: CatalystEventType.PARTNERSHIP }, state: MomentumCandidateState.ENTRY_READY }, skip: 10, take: 10, orderBy: [{ totalScore: 'desc' }, { id: 'asc' }] }));
    expect(mocks.securityFindMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ data: [{ symbol: 'AAPL', security: { name: 'Apple Inc.' }, tradingAvailability: { subscriptionCount: 2, enabledSubscriptionCount: 1 }, eligibility: { momentumSubscriptionEligibility: { eligible: false, reasons: ['NO_TRADING_ACCOUNT'] }, priceConfirmationEligible: false } }], pagination: { page: 2, pageSize: 10, total: 1, totalPages: 1 } });
  });

  it('paginates and filters catalysts with a safe sort field', async () => {
    mocks.catalystFindMany.mockResolvedValue([{ id: 'event-1', title: 'Apple catalyst', source: CatalystSource.MASSIVE_NEWS, sourceUrl: null, sourcePublisher: 'Newswire', publishedAt: now, receivedAt: now, eventType: CatalystEventType.PARTNERSHIP, eventTier: CatalystTier.HIGH, sentiment: CatalystSentiment.POSITIVE, tickerImpacts: [{ id: 'impact-1', symbol: 'AAPL' }], momentumCandidates: [{ id: 'candidate-1', symbol: 'AAPL', state: MomentumCandidateState.WATCHING }] }]);
    mocks.catalystCount.mockResolvedValue(1);
    const result = await listMomentumResearchCatalysts({ page: 1, pageSize: 20, search: 'AAPL', publisher: 'wire', source: CatalystSource.MASSIVE_NEWS, catalystType: CatalystEventType.PARTNERSHIP, tier: CatalystTier.HIGH, sentiment: CatalystSentiment.POSITIVE, sortBy: 'receivedAt', sortDirection: 'asc' });
    expect(mocks.catalystFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sourcePublisher: { contains: 'wire', mode: 'insensitive' }, source: CatalystSource.MASSIVE_NEWS, eventType: CatalystEventType.PARTNERSHIP, eventTier: CatalystTier.HIGH, sentiment: CatalystSentiment.POSITIVE }), orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], skip: 0, take: 20 }));
    expect(result.data[0]).toMatchObject({ impactedSymbols: ['AAPL'], candidateCount: 1 });
  });

  it('returns a complete candidate case file with chronological relationships', async () => {
    mocks.candidateFindUnique.mockResolvedValue(candidate({
      priceChecks: [{ id: 'check-1', observedAt: now, dayVolume: 123n, recentVolume: 45n }],
      scannerHandoffs: [{ id: 'handoff-1', status: 'PENDING', preparedAt: now }],
    }));
    mocks.securityFindUnique.mockResolvedValue({
      id: 1, symbol: 'AAPL', name: 'Apple Inc.', assetType: 'STOCK', enabled: true,
      sector: 'Technology', industry: null,
      momentumUniverseMember: { id: 'member-1', enabled: true },
      subscriptions: [{ id: 1, enabled: true }], trackedPositions: [],
    });

    const result = await getMomentumResearchCandidate('candidate-1');

    expect(mocks.candidateFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'candidate-1' },
      include: expect.objectContaining({ priceChecks: { orderBy: { observedAt: 'asc' } }, scannerHandoffs: expect.any(Object) }),
    }));
    expect(result).toMatchObject({
      candidate: { id: 'candidate-1', priceChecks: [{ dayVolume: '123', recentVolume: '45' }], scannerHandoffs: [{ id: 'handoff-1' }] },
      security: { symbol: 'AAPL', name: 'Apple Inc.' },
      universeMembership: { id: 'member-1' },
      tradingContext: { hasEnabledSubscription: true, openPositions: [] },
    });
  });

  it('returns not found for a missing candidate', async () => {
    await expect(getMomentumResearchCandidate('missing')).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.securityFindUnique).not.toHaveBeenCalled();
  });

  it('returns not found for a symbol without a Security record', async () => {
    await expect(getMomentumSymbolResearch('MISSING')).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.candidateFindMany).not.toHaveBeenCalled();
  });

  it('separates research, subscription, position, and candidate status', async () => {
    mocks.securityFindUnique.mockResolvedValue({
      id: 2, symbol: 'MSFT', name: 'Microsoft Corp.', assetType: 'STOCK', enabled: true,
      sector: 'Technology', industry: 'Software', momentumUniverseMember: null,
      subscriptions: [{
        id: 2, key: 'msft-momentum', name: 'MSFT momentum', symbol: 'MSFT',
        broker: 'ALPACA', brokerMode: 'PAPER', enabled: true,
        strategy: { id: 4, key: 'momentum_stock', name: 'Momentum Stock', enabled: true },
        exitProfile: null, tradingAccount: null, accountSubscriptions: [],
      }],
      trackedPositions: [{ id: 3, status: 'open' }],
    });
    mocks.candidateFindMany.mockResolvedValue([
      candidate({ id: 'candidate-new', symbol: 'MSFT', state: MomentumCandidateState.EXPIRED }),
      candidate({ id: 'candidate-old', symbol: 'MSFT', state: MomentumCandidateState.DISMISSED }),
    ]);

    const result = await getMomentumSymbolResearch('MSFT');

    expect(result).toMatchObject({
      researchStatus: { universeMember: false, universeEnabled: false, newsEnabled: false, priceScanningEnabled: false },
      tradingContext: { hasEnabledSubscription: true, hasOpenPosition: true },
      eligibility: {
        researchEligibility: { eligible: false, reasons: ['OUTSIDE_RESEARCH_UNIVERSE'] },
        momentumSubscriptionEligibility: { eligible: false, reasons: ['NO_TRADING_ACCOUNT'] },
        candidateEligibility: {
          discoveryEligible: false,
          priceConfirmationEligible: false,
          handoffEligible: false,
          priceConfirmationReasons: ['NO_ACTIVE_CANDIDATE'],
          handoffReasons: ['NO_ACTIVE_CANDIDATE'],
        },
      },
      currentCandidate: null,
      recentCandidates: [{ id: 'candidate-new' }, { id: 'candidate-old' }],
    });
    expect(mocks.candidateFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { symbol: 'MSFT', state: { in: [MomentumCandidateState.DISCOVERED, MomentumCandidateState.WATCHING, MomentumCandidateState.ENTRY_READY, MomentumCandidateState.ENTRY_BLOCKED] } },
    }));
  });
});
