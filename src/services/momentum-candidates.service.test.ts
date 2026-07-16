import {
  CatalystSentiment,
  CatalystSource,
  CatalystTickerRole,
  MomentumCandidateState,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  catalystTickerImpactFindMany: vi.fn(),
  momentumCandidateFindMany: vi.fn(),
  momentumCandidateFindUnique: vi.fn(),
  momentumCandidateUpsert: vi.fn(),
  placeOrder: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    catalystTickerImpact: {
      findMany: mocks.catalystTickerImpactFindMany,
    },
    momentumCandidate: {
      findMany: mocks.momentumCandidateFindMany,
      findUnique: mocks.momentumCandidateFindUnique,
      upsert: mocks.momentumCandidateUpsert,
    },
  },
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
  },
}));

vi.mock('./place-order.service.js', () => ({
  placeOrder: mocks.placeOrder,
}));

import {
  generateMomentumCandidatesFromCatalysts,
  getMomentumCandidateById,
  listMomentumCandidates,
} from './momentum-candidates.service.js';

function catalystEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'catalyst-event-1',
    source: CatalystSource.MASSIVE_NEWS,
    sourceExternalId: 'news-1',
    title: 'AAPL announces new AI partnership',
    sourceUrl: 'https://example.test/aapl',
    publishedAt: new Date('2026-07-04T14:00:00Z'),
    receivedAt: new Date('2026-07-04T14:01:00Z'),
    ...overrides,
  };
}

function catalystImpact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'impact-1',
    catalystEventId: 'catalyst-event-1',
    catalystEvent: catalystEvent(),
    securityId: 1,
    security: {
      id: 1,
      symbol: 'AAPL',
      momentumUniverseMember: {
        id: 'member-1',
        enabled: true,
      },
    },
    symbol: 'aapl',
    sentiment: CatalystSentiment.POSITIVE,
    sentimentReasoning: 'The partnership expands a growth catalyst.',
    relevanceScore: 35,
    actionabilityScore: 10,
    freshnessScore: 20,
    sourceQualityScore: 20,
    totalCatalystScore: 85,
    isPrimaryTicker: true,
    isCompanySpecific: true,
    isMarketWide: false,
    isSectorWide: false,
    catalystRole: CatalystTickerRole.PRIMARY_SUBJECT,
    blockedReason: null,
    rawInsight: null,
    metadata: null,
    createdAt: new Date('2026-07-04T14:01:00Z'),
    updatedAt: new Date('2026-07-04T14:01:00Z'),
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'candidate-1',
    securityId: 1,
    symbol: 'AAPL',
    state: MomentumCandidateState.DISCOVERED,
    catalystEventId: 'catalyst-event-1',
    catalystImpactId: 'impact-1',
    catalystScore: 85,
    priceActionScore: 0,
    volumeScore: 0,
    riskScore: 0,
    totalScore: 85,
    reason: 'The partnership expands a growth catalyst.',
    blockedReason: null,
    discoveredAt: new Date('2026-07-04T15:00:00Z'),
    lastEvaluatedAt: new Date('2026-07-04T15:00:00Z'),
    expiresAt: new Date('2026-07-05T15:00:00Z'),
    rawSnapshot: null,
    metadata: null,
    createdAt: new Date('2026-07-04T15:00:00Z'),
    updatedAt: new Date('2026-07-04T15:00:00Z'),
    ...overrides,
  };
}

describe('momentum candidates service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.catalystTickerImpactFindMany.mockResolvedValue([]);
    mocks.momentumCandidateFindMany.mockResolvedValue([]);
    mocks.momentumCandidateFindUnique.mockResolvedValue(null);
    mocks.momentumCandidateUpsert.mockImplementation(({ create }) =>
      Promise.resolve(candidate(create))
    );
  });

  it('creates a candidate from an eligible positive catalyst impact', async () => {
    const now = new Date('2026-07-04T15:00:00Z');
    const impact = catalystImpact();
    mocks.catalystTickerImpactFindMany.mockResolvedValue([impact]);

    await expect(
      generateMomentumCandidatesFromCatalysts({
        now,
        minCatalystScore: 60,
      })
    ).resolves.toMatchObject({
      evaluatedImpacts: 1,
      generatedCandidates: 1,
      minCatalystScore: 60,
      expiresAt: new Date('2026-07-05T15:00:00Z'),
    });

    expect(mocks.momentumCandidateUpsert).toHaveBeenCalledWith({
      where: {
        symbol_catalystImpactId: {
          symbol: 'AAPL',
          catalystImpactId: 'impact-1',
        },
      },
      create: expect.objectContaining({
        securityId: 1,
        symbol: 'AAPL',
        state: MomentumCandidateState.DISCOVERED,
        catalystEventId: 'catalyst-event-1',
        catalystImpactId: 'impact-1',
        catalystScore: 85,
        priceActionScore: 0,
        volumeScore: 0,
        riskScore: 0,
        totalScore: 85,
        discoveredAt: now,
        lastEvaluatedAt: now,
        expiresAt: new Date('2026-07-05T15:00:00Z'),
        metadata: {
          generatedBy: 'momentum_candidate_phase_3',
          priceVolumeConfirmation: 'deferred',
        },
      }),
      update: expect.objectContaining({
        securityId: 1,
        catalystScore: 85,
        priceActionScore: 0,
        volumeScore: 0,
        riskScore: 0,
        totalScore: 85,
        lastEvaluatedAt: now,
      }),
    });
    expect(mocks.momentumCandidateUpsert.mock.calls[0]?.[0].update).not.toHaveProperty(
      'expiresAt'
    );
  });

  it('filters to positive catalyst impacts above the configured threshold', async () => {
    const now = new Date('2026-07-04T15:00:00Z');
    const recentSince = new Date('2026-07-04T12:00:00Z');

    await generateMomentumCandidatesFromCatalysts({
      now,
      recentSince,
      minCatalystScore: 70,
    });

    expect(mocks.catalystTickerImpactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sentiment: CatalystSentiment.POSITIVE,
          totalCatalystScore: {
            gte: 70,
          },
          createdAt: {
            gte: recentSince,
          },
        }),
      })
    );
  });

  it('skips tangential and blocked catalyst impacts in the eligibility query', async () => {
    await generateMomentumCandidatesFromCatalysts();

    expect(mocks.catalystTickerImpactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          blockedReason: null,
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
        }),
      })
    );
  });

  it('does not create a second active candidate for the same security', async () => {
    const now = new Date('2026-07-04T16:00:00Z');
    const updatedImpact = catalystImpact({
      totalCatalystScore: 90,
      sentimentReasoning: 'Updated catalyst strength.',
    });
    mocks.catalystTickerImpactFindMany.mockResolvedValue([updatedImpact]);
    mocks.momentumCandidateFindMany.mockResolvedValue([{ securityId: 1 }]);

    const result = await generateMomentumCandidatesFromCatalysts({ now });

    expect(result.candidates).toHaveLength(0);
    expect(result.skipCounts.DUPLICATE_ACTIVE_CANDIDATE).toBe(1);
    expect(mocks.momentumCandidateUpsert).not.toHaveBeenCalled();
  });

  it('creates at most one active candidate per security within a batch', async () => {
    const now = new Date('2026-07-04T16:00:00Z');
    mocks.catalystTickerImpactFindMany.mockResolvedValue([
      catalystImpact({ id: 'impact-1' }),
      catalystImpact({ id: 'impact-2' }),
    ]);

    const result = await generateMomentumCandidatesFromCatalysts({ now });

    expect(result.generatedCandidates).toBe(1);
    expect(result.skipCounts.DUPLICATE_ACTIVE_CANDIDATE).toBe(1);
    expect(mocks.momentumCandidateUpsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['UNKNOWN_SECURITY', { security: null }],
    [
      'OUTSIDE_RESEARCH_UNIVERSE',
      {
        security: {
          id: 1,
          symbol: 'AAPL',
          momentumUniverseMember: null,
        },
      },
    ],
    [
      'UNIVERSE_DISABLED',
      {
        security: {
          id: 1,
          symbol: 'AAPL',
          momentumUniverseMember: { id: 'member-1', enabled: false },
        },
      },
    ],
  ])('skips candidate discovery with %s', async (reason, overrides) => {
    const now = new Date('2026-07-04T16:00:00Z');
    mocks.catalystTickerImpactFindMany.mockResolvedValue([
      catalystImpact(overrides),
    ]);

    const result = await generateMomentumCandidatesFromCatalysts({ now });

    expect(result.generatedCandidates).toBe(0);
    expect(result.skipCounts[reason as keyof typeof result.skipCounts]).toBe(1);
    expect(mocks.momentumCandidateUpsert).not.toHaveBeenCalled();
  });

  it('defensively skips a stale catalyst returned by the eligibility query', async () => {
    const now = new Date('2026-07-06T16:00:00Z');
    mocks.catalystTickerImpactFindMany.mockResolvedValue([catalystImpact()]);

    const result = await generateMomentumCandidatesFromCatalysts({
      now,
      recentSince: new Date('2026-07-05T16:00:00Z'),
    });

    expect(result.skipCounts.STALE_CATALYST).toBe(1);
    expect(mocks.momentumCandidateUpsert).not.toHaveBeenCalled();
  });

  it('lists and fetches candidate details with catalyst context', async () => {
    const rows = [candidate()];
    mocks.momentumCandidateFindMany.mockResolvedValue(rows);
    mocks.momentumCandidateFindUnique.mockResolvedValue(rows[0]);

    await expect(
      listMomentumCandidates({
        symbol: ' aapl ',
        state: MomentumCandidateState.DISCOVERED,
      })
    ).resolves.toEqual(rows);
    await expect(getMomentumCandidateById('candidate-1')).resolves.toEqual(
      rows[0]
    );

    expect(mocks.momentumCandidateFindMany).toHaveBeenCalledWith({
      where: {
        symbol: 'AAPL',
        state: MomentumCandidateState.DISCOVERED,
      },
      orderBy: [
        {
          totalScore: 'desc',
        },
        {
          discoveredAt: 'desc',
        },
      ],
      take: 100,
      include: {
        catalystEvent: true,
        catalystImpact: true,
      },
    });
    expect(mocks.momentumCandidateFindUnique).toHaveBeenCalledWith({
      where: {
        id: 'candidate-1',
      },
      include: {
        catalystEvent: true,
        catalystImpact: true,
      },
    });
  });

  it('does not invoke trading order behavior during candidate generation', async () => {
    mocks.catalystTickerImpactFindMany.mockResolvedValue([catalystImpact()]);

    await generateMomentumCandidatesFromCatalysts();

    expect(mocks.placeOrder).not.toHaveBeenCalled();
  });
});
