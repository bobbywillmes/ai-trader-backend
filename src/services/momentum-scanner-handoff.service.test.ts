import {
  CatalystEventType,
  CatalystSentiment,
  CatalystSource,
  CatalystTickerRole,
  CatalystTier,
  MomentumCandidateState,
  MomentumScannerHandoffStatus,
  Prisma,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handoffCreate: vi.fn(),
  handoffFindMany: vi.fn(),
  handoffFindUnique: vi.fn(),
  handoffUpdate: vi.fn(),
  momentumCandidateFindMany: vi.fn(),
  momentumCandidateFindUnique: vi.fn(),
  placeOrder: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: {
    MOMENTUM_HANDOFF_MIN_SCORE: 80,
    MOMENTUM_HANDOFF_MAX_CANDIDATES: 10,
    MOMENTUM_HANDOFF_PAYLOAD_VERSION: 'v1',
  },
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    momentumCandidate: {
      findMany: mocks.momentumCandidateFindMany,
      findUnique: mocks.momentumCandidateFindUnique,
    },
    momentumScannerHandoff: {
      create: mocks.handoffCreate,
      findMany: mocks.handoffFindMany,
      findUnique: mocks.handoffFindUnique,
      update: mocks.handoffUpdate,
    },
  },
}));

vi.mock('./place-order.service.js', () => ({
  placeOrder: mocks.placeOrder,
}));

import {
  buildMomentumScannerPayload,
  listMomentumScannerHandoffs,
  markMomentumScannerHandoffAcknowledged,
  markMomentumScannerHandoffFailed,
  markMomentumScannerHandoffSent,
  prepareMomentumScannerHandoff,
  prepareReadyMomentumScannerHandoffs,
} from './momentum-scanner-handoff.service.js';

function catalystEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'catalyst-event-1',
    source: CatalystSource.MASSIVE_NEWS,
    sourceExternalId: 'news-1',
    sourceUrl: 'https://example.test/mu',
    sourcePublisher: 'The Motley Fool',
    sourceAuthor: 'Reporter',
    title: 'MU announces AI memory catalyst',
    summary: 'Micron demand accelerates.',
    bodyExcerpt: 'Large raw article excerpt not included in handoff.',
    language: 'en',
    publishedAt: new Date('2026-07-04T14:00:00.000Z'),
    receivedAt: new Date('2026-07-04T14:01:00.000Z'),
    eventType: CatalystEventType.PARTNERSHIP,
    eventTier: CatalystTier.HIGH,
    sentiment: CatalystSentiment.POSITIVE,
    confidence: 0.92,
    isDuplicate: false,
    duplicateOfId: null,
    rawPayload: {
      vendorSecretLikeBlob: true,
    },
    metadata: null,
    createdAt: new Date('2026-07-04T14:01:00.000Z'),
    updatedAt: new Date('2026-07-04T14:01:00.000Z'),
    ...overrides,
  };
}

function catalystImpact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'impact-1',
    catalystEventId: 'catalyst-event-1',
    symbol: 'MU',
    sentiment: CatalystSentiment.POSITIVE,
    sentimentReasoning: 'Direct beneficiary from AI memory demand.',
    relevanceScore: 35,
    actionabilityScore: 20,
    freshnessScore: 15,
    sourceQualityScore: 12,
    totalCatalystScore: 82,
    isPrimaryTicker: true,
    isCompanySpecific: true,
    isMarketWide: false,
    isSectorWide: false,
    catalystRole: CatalystTickerRole.DIRECT_BENEFICIARY,
    blockedReason: null,
    rawInsight: {
      rawModelOutput: true,
    },
    metadata: null,
    createdAt: new Date('2026-07-04T14:02:00.000Z'),
    updatedAt: new Date('2026-07-04T14:02:00.000Z'),
    ...overrides,
  };
}

function priceCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 'price-check-1',
    momentumCandidateId: 'candidate-1',
    symbol: 'MU',
    observedAt: new Date('2026-07-04T15:30:00.000Z'),
    lastPrice: new Prisma.Decimal('103'),
    previousClose: new Prisma.Decimal('100'),
    pctFromPreviousClose: new Prisma.Decimal('3'),
    intradayHigh: new Prisma.Decimal('104'),
    intradayLow: new Prisma.Decimal('98'),
    distanceFromHighPct: new Prisma.Decimal('0.96'),
    sessionVwap: new Prisma.Decimal('101'),
    aboveVwap: true,
    dayVolume: 1_000_000n,
    dollarVolume: new Prisma.Decimal('103000000'),
    relativeVolume: new Prisma.Decimal('2.5'),
    recentMovePct: new Prisma.Decimal('1.2'),
    recentVolume: 250_000n,
    priceActionScore: 90,
    volumeScore: 80,
    riskScore: 75,
    totalConfirmationScore: 87,
    confirmed: true,
    decision: 'ENTRY_READY',
    blockedReason: null,
    rawPayload: {
      vendorRaw: true,
    },
    metadata: null,
    createdAt: new Date('2026-07-04T15:31:00.000Z'),
    updatedAt: new Date('2026-07-04T15:31:00.000Z'),
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'candidate-1',
    symbol: 'MU',
    state: MomentumCandidateState.ENTRY_READY,
    catalystEventId: 'catalyst-event-1',
    catalystEvent: catalystEvent(),
    catalystImpactId: 'impact-1',
    catalystImpact: catalystImpact(),
    catalystScore: 82,
    priceActionScore: 90,
    volumeScore: 70,
    riskScore: 80,
    totalScore: 87,
    reason: 'Strong catalyst and confirmed price action.',
    blockedReason: null,
    discoveredAt: new Date('2026-07-04T14:05:00.000Z'),
    lastEvaluatedAt: new Date('2026-07-04T15:31:00.000Z'),
    expiresAt: new Date('2026-07-05T14:05:00.000Z'),
    rawSnapshot: {
      previousRaw: true,
    },
    metadata: null,
    priceChecks: [priceCheck()],
    scannerHandoffs: [],
    createdAt: new Date('2026-07-04T14:05:00.000Z'),
    updatedAt: new Date('2026-07-04T15:31:00.000Z'),
    ...overrides,
  };
}

function handoff(overrides: Record<string, unknown> = {}) {
  const payload = {
    type: 'momentum_candidate.ready',
    version: 'v1',
    idempotencyKey: 'momentum-candidate:candidate-1:v1',
  };

  return {
    id: 'handoff-1',
    momentumCandidateId: 'candidate-1',
    momentumCandidate: candidate(),
    symbol: 'MU',
    status: MomentumScannerHandoffStatus.PENDING,
    payloadVersion: 'v1',
    payload,
    preparedAt: new Date('2026-07-04T15:32:00.000Z'),
    sentAt: null,
    acknowledgedAt: null,
    failedAt: null,
    attempts: 0,
    lastError: null,
    idempotencyKey: 'momentum-candidate:candidate-1:v1',
    metadata: null,
    createdAt: new Date('2026-07-04T15:32:00.000Z'),
    updatedAt: new Date('2026-07-04T15:32:00.000Z'),
    ...overrides,
  };
}

describe('momentum scanner handoff service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.momentumCandidateFindUnique.mockResolvedValue(candidate());
    mocks.momentumCandidateFindMany.mockResolvedValue([]);
    mocks.handoffFindUnique.mockResolvedValue(null);
    mocks.handoffFindMany.mockResolvedValue([handoff()]);
    mocks.handoffCreate.mockImplementation(({ data }) =>
      Promise.resolve(handoff(data))
    );
    mocks.handoffUpdate.mockImplementation(({ data }) =>
      Promise.resolve(handoff(data))
    );
  });

  it('prepares a handoff for an ENTRY_READY candidate above threshold', async () => {
    const now = new Date('2026-07-04T15:32:00.000Z');

    await expect(
      prepareMomentumScannerHandoff('candidate-1', { now })
    ).resolves.toMatchObject({
      skipped: false,
      handoff: {
        status: MomentumScannerHandoffStatus.PENDING,
        symbol: 'MU',
        idempotencyKey: 'momentum-candidate:candidate-1:v1',
      },
    });

    expect(mocks.handoffCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        momentumCandidateId: 'candidate-1',
        symbol: 'MU',
        status: MomentumScannerHandoffStatus.PENDING,
        payloadVersion: 'v1',
        preparedAt: now,
        idempotencyKey: 'momentum-candidate:candidate-1:v1',
      }),
      include: expect.any(Object),
    });
  });

  it('skips non-ready, expired, low-score, blocked, and active-handoff candidates', async () => {
    const cases = [
      candidate({ state: MomentumCandidateState.WATCHING }),
      candidate({ expiresAt: new Date('2026-07-04T15:00:00.000Z') }),
      candidate({ totalScore: 79 }),
      candidate({ blockedReason: 'PRICE_BELOW_MINIMUM' }),
      candidate({ scannerHandoffs: [handoff()] }),
    ];

    for (const row of cases) {
      vi.clearAllMocks();
      mocks.momentumCandidateFindUnique.mockResolvedValue(row);

      await expect(
        prepareMomentumScannerHandoff('candidate-1', {
          now: new Date('2026-07-04T15:32:00.000Z'),
        })
      ).resolves.toMatchObject({
        skipped: true,
        handoff: null,
      });
      expect(mocks.handoffCreate).not.toHaveBeenCalled();
    }
  });

  it('builds a review-only payload with candidate, catalyst, and latest price data only', async () => {
    const payload = await buildMomentumScannerPayload('candidate-1');

    expect(payload).toMatchObject({
      type: 'momentum_candidate.ready',
      version: 'v1',
      idempotencyKey: 'momentum-candidate:candidate-1:v1',
      candidate: {
        id: 'candidate-1',
        symbol: 'MU',
        state: MomentumCandidateState.ENTRY_READY,
        totalScore: 87,
      },
      catalyst: {
        eventId: 'catalyst-event-1',
        impactId: 'impact-1',
        source: CatalystSource.MASSIVE_NEWS,
        publisher: 'The Motley Fool',
        title: 'MU announces AI memory catalyst',
        sentiment: CatalystSentiment.POSITIVE,
        tickerRole: CatalystTickerRole.DIRECT_BENEFICIARY,
        totalCatalystScore: 82,
      },
      priceConfirmation: {
        priceCheckId: 'price-check-1',
        lastPrice: '103',
        dayVolume: '1000000',
        confirmed: true,
        decision: 'ENTRY_READY',
      },
      reviewGuidance: {
        recommendedAction: 'REVIEW_ONLY',
        tradingAllowed: false,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('vendorRaw');
    expect(JSON.stringify(payload)).not.toContain('vendorSecretLikeBlob');
    expect(JSON.stringify(payload)).not.toContain('rawModelOutput');
  });

  it('returns an existing idempotent handoff instead of creating a duplicate', async () => {
    mocks.handoffFindUnique.mockResolvedValue(handoff());

    const result = await prepareMomentumScannerHandoff('candidate-1', {
      now: new Date('2026-07-04T15:32:00.000Z'),
    });

    expect(result).toMatchObject({
      skipped: false,
      handoff: {
        id: 'handoff-1',
      },
    });
    expect(mocks.handoffCreate).not.toHaveBeenCalled();
  });

  it('force refreshes the idempotent handoff without creating a second row', async () => {
    const existing = handoff({
      status: MomentumScannerHandoffStatus.SENT,
      sentAt: new Date('2026-07-04T15:35:00.000Z'),
      attempts: 1,
    });
    mocks.momentumCandidateFindUnique.mockResolvedValue(
      candidate({ scannerHandoffs: [existing] })
    );
    mocks.handoffFindUnique.mockResolvedValue(existing);

    await prepareMomentumScannerHandoff('candidate-1', {
      force: true,
      now: new Date('2026-07-04T16:00:00.000Z'),
    });

    expect(mocks.handoffUpdate).toHaveBeenCalledWith({
      where: {
        id: 'handoff-1',
      },
      data: expect.objectContaining({
        status: MomentumScannerHandoffStatus.PENDING,
        sentAt: null,
        acknowledgedAt: null,
        failedAt: null,
        lastError: null,
      }),
      include: expect.any(Object),
    });
    expect(mocks.handoffCreate).not.toHaveBeenCalled();
  });

  it('batch prepare respects maxCandidates and readiness filters', async () => {
    mocks.momentumCandidateFindMany.mockResolvedValue([
      candidate({ id: 'candidate-1', symbol: 'MU' }),
      candidate({ id: 'candidate-2', symbol: 'AMD' }),
    ]);
    mocks.momentumCandidateFindUnique.mockImplementation(({ where }) =>
      Promise.resolve(candidate({ id: where.id }))
    );

    const result = await prepareReadyMomentumScannerHandoffs({
      maxCandidates: 2,
      minScore: 85,
      now: new Date('2026-07-04T16:00:00.000Z'),
    });

    expect(result.prepared).toBe(2);
    expect(mocks.momentumCandidateFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: MomentumCandidateState.ENTRY_READY,
          totalScore: {
            gte: 85,
          },
          blockedReason: null,
        }),
        take: 2,
      })
    );
  });

  it('marks sent, acknowledged, and failed handoff statuses', async () => {
    const now = new Date('2026-07-04T16:00:00.000Z');

    await markMomentumScannerHandoffSent('handoff-1', { now });
    expect(mocks.handoffUpdate).toHaveBeenLastCalledWith({
      where: {
        id: 'handoff-1',
      },
      data: expect.objectContaining({
        status: MomentumScannerHandoffStatus.SENT,
        sentAt: now,
        attempts: {
          increment: 1,
        },
        lastError: null,
      }),
      include: expect.any(Object),
    });

    await markMomentumScannerHandoffAcknowledged('handoff-1', { now });
    expect(mocks.handoffUpdate).toHaveBeenLastCalledWith({
      where: {
        id: 'handoff-1',
      },
      data: expect.objectContaining({
        status: MomentumScannerHandoffStatus.ACKNOWLEDGED,
        acknowledgedAt: now,
        lastError: null,
      }),
      include: expect.any(Object),
    });

    await markMomentumScannerHandoffFailed('handoff-1', 'delivery failed', {
      now,
    });
    expect(mocks.handoffUpdate).toHaveBeenLastCalledWith({
      where: {
        id: 'handoff-1',
      },
      data: expect.objectContaining({
        status: MomentumScannerHandoffStatus.FAILED,
        failedAt: now,
        lastError: 'delivery failed',
      }),
      include: expect.any(Object),
    });
  });

  it('lists handoffs with normalized filters', async () => {
    await listMomentumScannerHandoffs({
      candidateId: ' candidate-1 ',
      symbol: ' mu ',
      status: MomentumScannerHandoffStatus.PENDING,
      limit: 25,
    });

    expect(mocks.handoffFindMany).toHaveBeenCalledWith({
      where: {
        momentumCandidateId: 'candidate-1',
        symbol: 'MU',
        status: MomentumScannerHandoffStatus.PENDING,
      },
      orderBy: [
        {
          preparedAt: 'desc',
        },
        {
          createdAt: 'desc',
        },
      ],
      take: 25,
      include: expect.any(Object),
    });
  });

  it('does not invoke trading order behavior during handoff preparation', async () => {
    await prepareMomentumScannerHandoff('candidate-1');

    expect(mocks.placeOrder).not.toHaveBeenCalled();
  });
});
