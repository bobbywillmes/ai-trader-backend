import { MomentumCandidateState, TradingAccountStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTickerPriceConfirmationMarketData: vi.fn(),
  momentumCandidateFindMany: vi.fn(),
  momentumCandidateFindUnique: vi.fn(),
  momentumCandidateUpdate: vi.fn(),
  priceCheckCreate: vi.fn(),
  priceCheckFindMany: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: {
    MOMENTUM_CONFIRMATION_MIN_PRICE: 5,
    MOMENTUM_CONFIRMATION_MIN_DOLLAR_VOLUME: 5_000_000,
    MOMENTUM_CONFIRMATION_WATCHING_THRESHOLD: 60,
    MOMENTUM_CONFIRMATION_ENTRY_READY_THRESHOLD: 80,
    MOMENTUM_CONFIRMATION_MAX_SYMBOLS_PER_RUN: 10,
    MOMENTUM_CONFIRMATION_RECENT_WINDOW_MINUTES: 30,
    MOMENTUM_CONFIRMATION_LOOKBACK_MINUTES: 390,
    MOMENTUM_CONFIRMATION_MAX_PCT_FROM_PREV_CLOSE: 20,
  },
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    momentumCandidate: {
      findMany: mocks.momentumCandidateFindMany,
      findUnique: mocks.momentumCandidateFindUnique,
      update: mocks.momentumCandidateUpdate,
    },
    momentumCandidatePriceCheck: {
      create: mocks.priceCheckCreate,
      findMany: mocks.priceCheckFindMany,
    },
  },
}));

vi.mock('./massive-market-data.service.js', () => ({
  getTickerPriceConfirmationMarketData:
    mocks.getTickerPriceConfirmationMarketData,
}));

import {
  confirmActiveCandidates,
  confirmCandidatePrice,
  listMomentumCandidatePriceChecks,
} from './momentum-price-confirmation.service.js';

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'candidate-1',
    securityId: 1,
    security: {
      id: 1,
      momentumUniverseMember: {
        enabled: true,
        priceScanningEnabled: true,
      },
      subscriptions: [
        {
          id: 1,
          key: 'aapl-momentum',
          enabled: true,
          strategy: { id: 1, key: 'momentum_stock', enabled: true },
          accountSubscriptions: [
            {
              id: 1,
              enabled: true,
              entriesEnabled: true,
              tradingAccount: { id: 1, status: TradingAccountStatus.ACTIVE },
              allocation: { id: 1, enabled: true },
            },
          ],
        },
      ],
    },
    symbol: 'AAPL',
    state: MomentumCandidateState.DISCOVERED,
    catalystEventId: 'catalyst-event-1',
    catalystImpactId: 'impact-1',
    catalystScore: 90,
    priceActionScore: 0,
    volumeScore: 0,
    riskScore: 0,
    totalScore: 90,
    reason: 'Strong catalyst.',
    blockedReason: null,
    discoveredAt: new Date('2026-07-04T14:00:00.000Z'),
    lastEvaluatedAt: new Date('2026-07-04T14:00:00.000Z'),
    expiresAt: new Date('2099-07-05T14:00:00.000Z'),
    rawSnapshot: {
      catalystEvent: {
        id: 'catalyst-event-1',
        title: 'AAPL catalyst',
      },
      catalystImpact: {
        id: 'impact-1',
      },
    },
    metadata: null,
    createdAt: new Date('2026-07-04T14:00:00.000Z'),
    updatedAt: new Date('2026-07-04T14:00:00.000Z'),
    ...overrides,
  };
}

function marketData(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'AAPL',
    from: '2026-07-04',
    to: '2026-07-04',
    snapshot: {
      symbol: 'AAPL',
      lastPrice: 103,
      previousClose: 100,
      intradayHigh: 103.5,
      intradayLow: 98,
      dayVolume: 100_000,
      sessionVwap: 100,
      updatedTime: '2026-07-04T15:31:00.000Z',
    },
    minuteBars: [
      {
        time: '2026-07-04T15:00:00.000Z',
        open: 101,
        high: 102,
        low: 100.5,
        close: 101.5,
        volume: 30_000,
        vwap: 101,
      },
      {
        time: '2026-07-04T15:30:00.000Z',
        open: 101.5,
        high: 103.5,
        low: 101,
        close: 103,
        volume: 70_000,
        vwap: 102,
      },
    ],
    rawPayload: {
      snapshot: {
        ticker: 'AAPL',
      },
      aggregates: {
        results: 2,
      },
    },
    ...overrides,
  };
}

describe('momentum price confirmation service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTickerPriceConfirmationMarketData.mockResolvedValue(marketData());
    mocks.momentumCandidateFindMany.mockResolvedValue([]);
    mocks.momentumCandidateFindUnique.mockResolvedValue(candidate());
    mocks.priceCheckCreate.mockImplementation(({ data }) =>
      Promise.resolve({
        id: `price-check-${mocks.priceCheckCreate.mock.calls.length}`,
        ...data,
      })
    );
    mocks.priceCheckFindMany.mockResolvedValue([{ id: 'price-check-1' }]);
    mocks.momentumCandidateUpdate.mockImplementation(({ data }) =>
      Promise.resolve(candidate(data))
    );
  });

  it('creates a price check and updates latest candidate scores', async () => {
    const now = new Date('2026-07-04T15:31:00.000Z');

    await expect(
      confirmCandidatePrice('candidate-1', { now })
    ).resolves.toMatchObject({
      skipped: false,
      candidate: {
        state: MomentumCandidateState.ENTRY_READY,
        priceActionScore: 100,
        volumeScore: 90,
        riskScore: 100,
        totalScore: 94,
        blockedReason: null,
      },
      priceCheck: {
        momentumCandidateId: 'candidate-1',
        symbol: 'AAPL',
        observedAt: now,
        priceActionScore: 100,
        volumeScore: 90,
        riskScore: 100,
        totalConfirmationScore: 94,
        confirmed: true,
        decision: 'ENTRY_READY',
        blockedReason: null,
      },
    });

    expect(mocks.priceCheckCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        momentumCandidateId: 'candidate-1',
        symbol: 'AAPL',
        lastPrice: 103,
        previousClose: 100,
        pctFromPreviousClose: 3,
        dayVolume: 100000n,
        dollarVolume: 10_300_000,
        recentVolume: 70000n,
        scoringVersion: 'momentum_confirmation_v4',
        scoringInputs: expect.objectContaining({
          lastPrice: 103,
          dayVolume: '100000',
          recentVolume: '70000',
          relativeVolume: null,
          observedAt: now.toISOString(),
        }),
        scoreExplanation: expect.objectContaining({
          scoringVersion: 'momentum_confirmation_v4',
          componentScores: {
            priceAction: 100,
            volume: 90,
            setupQuality: 100,
            totalConfirmation: 94,
          },
          hardBlocks: [],
          decision: 'ENTRY_READY',
          confirmed: true,
          dataCompleteness: {
            complete: true,
            missingInputs: [],
          },
        }),
      }),
    });
    expect(mocks.momentumCandidateUpdate).toHaveBeenCalledWith({
      where: {
        id: 'candidate-1',
      },
      data: expect.objectContaining({
        state: MomentumCandidateState.ENTRY_READY,
        priceActionScore: 100,
        volumeScore: 90,
        riskScore: 100,
        totalScore: 94,
        lastEvaluatedAt: now,
        rawSnapshot: expect.objectContaining({
          catalystEvent: {
            id: 'catalyst-event-1',
            title: 'AAPL catalyst',
          },
          catalystImpact: {
            id: 'impact-1',
          },
          latestPriceConfirmation: expect.objectContaining({
            symbol: 'AAPL',
          }),
        }),
      }),
    });
    const updatePayload = mocks.momentumCandidateUpdate.mock.calls[0]![0].data;

    expect(updatePayload.rawSnapshot).not.toHaveProperty('previous');
    expect(updatePayload.rawSnapshot).not.toHaveProperty('priceConfirmation');
  });

  it('blocks a moderate price setup when dollar liquidity is insufficient', async () => {
    mocks.momentumCandidateFindUnique.mockResolvedValue(
      candidate({
        catalystScore: 70,
        state: MomentumCandidateState.DISCOVERED,
      })
    );
    mocks.getTickerPriceConfirmationMarketData.mockResolvedValue(
      marketData({
        snapshot: {
          symbol: 'AAPL',
          lastPrice: 102.5,
          previousClose: 100,
          intradayHigh: 105,
          intradayLow: 99,
          dayVolume: 100,
          sessionVwap: 102,
          updatedTime: '2026-07-04T15:31:00.000Z',
        },
        minuteBars: [
          {
            time: '2026-07-04T15:30:00.000Z',
            open: 101,
            high: 102.5,
            low: 100.5,
            close: 102.5,
            volume: 100,
            vwap: 101,
          },
        ],
      })
    );

    const result = await confirmCandidatePrice('candidate-1', {
      now: new Date('2026-07-04T15:31:00.000Z'),
    });

    expect(result.candidate).toMatchObject({
      state: MomentumCandidateState.ENTRY_BLOCKED,
      totalScore: 73,
      blockedReason: 'INSUFFICIENT_DOLLAR_LIQUIDITY',
    });
    expect(result.priceCheck).toMatchObject({
      confirmed: false,
      blockedReason: 'INSUFFICIENT_DOLLAR_LIQUIDITY',
      scoreExplanation: expect.objectContaining({
        componentScores: expect.objectContaining({
          setupQuality: 70,
        }),
        hardBlocks: expect.arrayContaining(['INSUFFICIENT_DOLLAR_LIQUIDITY']),
        reasons: expect.arrayContaining(['BELOW_TARGET_DOLLAR_LIQUIDITY']),
      }),
    });
  });

  it('blocks a candidate when a hard risk rule fails', async () => {
    mocks.getTickerPriceConfirmationMarketData.mockResolvedValue(
      marketData({
        snapshot: {
          symbol: 'AAPL',
          lastPrice: 4.5,
          previousClose: 4.4,
          intradayHigh: 4.6,
          intradayLow: 4.3,
          dayVolume: 1_000_000,
          sessionVwap: 4.45,
          updatedTime: '2026-07-04T15:31:00.000Z',
        },
      })
    );

    const result = await confirmCandidatePrice('candidate-1', {
      now: new Date('2026-07-04T15:31:00.000Z'),
    });

    expect(result.candidate).toMatchObject({
      state: MomentumCandidateState.ENTRY_BLOCKED,
      blockedReason: 'PRICE_BELOW_MINIMUM',
    });
    expect(result.priceCheck).toMatchObject({
      confirmed: false,
      decision: 'PRICE_BELOW_MINIMUM',
      blockedReason: 'PRICE_BELOW_MINIMUM',
      scoringVersion: 'momentum_confirmation_v4',
      scoreExplanation: {
        hardBlocks: ['PRICE_BELOW_MINIMUM', 'TOO_FAR_FROM_INTRADAY_HIGH'],
      },
    });
  });

  it('handles missing price data gracefully with a stored blocked check', async () => {
    mocks.getTickerPriceConfirmationMarketData.mockResolvedValue(
      marketData({
        snapshot: {
          symbol: 'AAPL',
          lastPrice: null,
          previousClose: 100,
          intradayHigh: null,
          intradayLow: null,
          dayVolume: null,
          sessionVwap: null,
          updatedTime: null,
        },
        minuteBars: [],
      })
    );

    const result = await confirmCandidatePrice('candidate-1', {
      now: new Date('2026-07-04T15:31:00.000Z'),
    });

    expect(result.candidate).toMatchObject({
      state: MomentumCandidateState.ENTRY_BLOCKED,
      blockedReason: 'MISSING_LAST_PRICE',
    });
    expect(mocks.priceCheckCreate).toHaveBeenCalledTimes(1);
  });

  it('skips expired and dismissed candidates without writing price checks', async () => {
    for (const state of [
      MomentumCandidateState.EXPIRED,
      MomentumCandidateState.DISMISSED,
    ]) {
      vi.clearAllMocks();
      mocks.momentumCandidateFindUnique.mockResolvedValue(candidate({ state }));

      await expect(confirmCandidatePrice('candidate-1')).resolves.toMatchObject({
        skipped: true,
        priceCheck: null,
        candidate: {
          state,
        },
      });
      expect(mocks.priceCheckCreate).not.toHaveBeenCalled();
      expect(mocks.momentumCandidateUpdate).not.toHaveBeenCalled();
    }
  });

  it('does not request market data for a configuration-ineligible candidate', async () => {
    mocks.momentumCandidateFindUnique.mockResolvedValue(
      candidate({ security: { ...candidate().security, subscriptions: [] } })
    );

    await expect(confirmCandidatePrice('candidate-1')).resolves.toMatchObject({
      skipped: true,
      eligibility: { eligible: false, reasons: ['NO_SUBSCRIPTION'] },
      priceCheck: null,
    });

    expect(mocks.getTickerPriceConfirmationMarketData).not.toHaveBeenCalled();
    expect(mocks.priceCheckCreate).not.toHaveBeenCalled();
  });

  it('respects the configured max candidate limit when confirming a batch', async () => {
    mocks.momentumCandidateFindMany.mockResolvedValue([
      candidate({ id: 'candidate-1', symbol: 'AAPL' }),
      candidate({ id: 'candidate-2', symbol: 'MSFT' }),
    ]);
    mocks.momentumCandidateFindUnique.mockImplementation(({ where }) =>
      Promise.resolve(candidate({ id: where.id }))
    );

    await confirmActiveCandidates({
      maxCandidates: 2,
      minCatalystScore: 80,
    });

    expect(mocks.momentumCandidateFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        state: {
          in: [
            MomentumCandidateState.DISCOVERED,
            MomentumCandidateState.WATCHING,
            MomentumCandidateState.ENTRY_READY,
            MomentumCandidateState.ENTRY_BLOCKED,
          ],
        },
        catalystScore: {
          gte: 80,
        },
      },
      orderBy: [
        {
          totalScore: 'desc',
        },
        {
          discoveredAt: 'asc',
        },
      ],
      take: 10,
    }));
  });

  it('repeated confirmation keeps candidate raw snapshots shallow', async () => {
    await confirmCandidatePrice('candidate-1');
    await confirmCandidatePrice('candidate-1');

    expect(mocks.priceCheckCreate).toHaveBeenCalledTimes(2);
    expect(mocks.momentumCandidateUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.momentumCandidateFindUnique).toHaveBeenCalledTimes(2);

    for (const call of mocks.momentumCandidateUpdate.mock.calls) {
      expect(call[0].data.rawSnapshot).toMatchObject({
        catalystEvent: {
          id: 'catalyst-event-1',
        },
        catalystImpact: {
          id: 'impact-1',
        },
        latestPriceConfirmation: {
          symbol: 'AAPL',
        },
      });
      expect(call[0].data.rawSnapshot).not.toHaveProperty('previous');
    }
  });

  it('flattens an existing nested raw snapshot on the next confirmation', async () => {
    mocks.momentumCandidateFindUnique.mockResolvedValue(
      candidate({
        rawSnapshot: {
          previous: {
            previous: {
              previous: {
                catalystEvent: {
                  id: 'nested-event',
                  title: 'Nested catalyst',
                },
                catalystImpact: {
                  id: 'nested-impact',
                  totalCatalystScore: 90,
                },
              },
              priceConfirmation: {
                symbol: 'AAPL',
              },
            },
          },
          priceConfirmation: {
            symbol: 'AAPL',
          },
        },
      })
    );

    await confirmCandidatePrice('candidate-1');

    expect(mocks.priceCheckCreate).toHaveBeenCalledTimes(1);
    expect(mocks.momentumCandidateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rawSnapshot: expect.objectContaining({
            catalystEvent: {
              id: 'nested-event',
              title: 'Nested catalyst',
            },
            catalystImpact: {
              id: 'nested-impact',
              totalCatalystScore: 90,
            },
            latestPriceConfirmation: expect.objectContaining({
              symbol: 'AAPL',
            }),
          }),
        }),
      })
    );

    const updatePayload = mocks.momentumCandidateUpdate.mock.calls[0]![0].data;

    expect(updatePayload.rawSnapshot).not.toHaveProperty('previous');
    expect(updatePayload.rawSnapshot).not.toHaveProperty('priceConfirmation');
  });

  it('still creates one price-check history row per confirmation', async () => {
    await confirmCandidatePrice('candidate-1');
    await confirmCandidatePrice('candidate-1');

    expect(mocks.priceCheckCreate).toHaveBeenCalledTimes(2);
  });

  it('lists recent price checks for a candidate newest first', async () => {
    await expect(
      listMomentumCandidatePriceChecks(' candidate-1 ', { limit: 10 })
    ).resolves.toEqual([{ id: 'price-check-1' }]);

    expect(mocks.momentumCandidateFindUnique).toHaveBeenCalledWith({
      where: {
        id: 'candidate-1',
      },
      select: {
        id: true,
      },
    });
    expect(mocks.priceCheckFindMany).toHaveBeenCalledWith({
      where: {
        momentumCandidateId: 'candidate-1',
      },
      orderBy: {
        observedAt: 'desc',
      },
      take: 10,
    });
  });
});
