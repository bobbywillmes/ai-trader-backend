import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listTradeCycles: vi.fn(),
}));

vi.mock('./trade-cycles.service.js', () => ({
  listTradeCycles: mocks.listTradeCycles,
}));

import { getTradePerformance } from './trade-performance.service.js';

function cycle(overrides: Record<string, unknown> = {}) {
  return {
    ...baseCycle(),
    ...overrides,
  };
}

function baseCycle() {
  return {
    id: 1,
    symbol: 'SPY',
    side: 'long',
    openedAt: new Date('2026-06-10T14:30:00Z'),
    closedAt: new Date('2026-06-10T16:00:00Z'),
    quantity: 1.5,
    avgEntryPrice: 100.25,
    avgExitPrice: 102.25,
    realizedPnl: 10,
    returnPct: 0.02,
    holdingDurationMs: 60_000,
    strategy: { id: 1, key: 'strategy_a', name: 'Strategy A' },
    subscription: {
      id: 1,
      key: 'sub_a',
      name: 'Sub A',
      brokerMode: 'paper',
    },
    exitProfile: { id: 1, key: 'exit_a', name: 'Exit A' },
    exitReason: 'target',
  };
}

describe('trade performance service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('summarizes realized performance and groups by lifecycle dimensions', async () => {
    mocks.listTradeCycles.mockResolvedValue({
      cycles: [
        cycle({
          id: 1,
          symbol: 'SPY',
          realizedPnl: 20,
          returnPct: 0.04,
          strategy: { id: 1, key: 'strategy_a', name: 'Strategy A' },
        }),
        cycle({
          id: 2,
          symbol: 'QQQ',
          realizedPnl: -5,
          returnPct: -0.01,
          strategy: { id: 2, key: 'strategy_b', name: 'Strategy B' },
          subscription: {
            id: 2,
            key: 'sub_b',
            name: 'Sub B',
            brokerMode: 'paper',
          },
          exitProfile: { id: 2, key: 'exit_b', name: 'Exit B' },
          exitReason: 'stop_loss',
          holdingDurationMs: 180_000,
        }),
        cycle({
          id: 3,
          symbol: 'SPY',
          realizedPnl: null,
          returnPct: null,
        }),
      ],
    });

    const result = await getTradePerformance({
      mode: 'paper',
    });

    expect(mocks.listTradeCycles).toHaveBeenCalledWith({
      status: 'closed',
      mode: 'paper',
      limit: null,
    });

    expect(result.summary).toEqual({
      tradeCount: 3,
      reportableTradeCount: 2,
      totalRealizedPnl: 15,
      averageReturnPct: 0.015,
      winRate: 0.5,
      winnerCount: 1,
      loserCount: 1,
      averageWinner: 20,
      averageLoser: -5,
      profitFactor: 4,
      averageHoldingDurationMs: 120_000,
    });

    expect(result.groups.byStrategy).toEqual([
      expect.objectContaining({
        id: 'strategy_a',
        label: 'Strategy A',
        totalRealizedPnl: 20,
      }),
      expect.objectContaining({
        id: 'strategy_b',
        label: 'Strategy B',
        totalRealizedPnl: -5,
      }),
    ]);
    expect(result.groups.bySecurity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'SPY',
          label: 'SPY',
          totalRealizedPnl: 20,
        }),
      ])
    );
    expect(result.groups.byExitReason).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'stop_loss',
          label: 'stop_loss',
          totalRealizedPnl: -5,
        }),
      ])
    );
  });

  it('pushes database-safe filters into the trade-cycle query', async () => {
    mocks.listTradeCycles.mockResolvedValue({
      cycles: [
        cycle({
          id: 1,
          symbol: 'SPY',
          closedAt: new Date('2026-06-10T16:00:00Z'),
          realizedPnl: 20,
        }),
      ],
    });

    await getTradePerformance({
      dateFrom: new Date('2026-06-01T00:00:00Z'),
      dateTo: new Date('2026-06-30T23:59:59Z'),
      symbol: 'spy',
      strategyId: 10,
      subscriptionId: 20,
      exitProfileId: 30,
      mode: 'paper',
    });

    expect(mocks.listTradeCycles).toHaveBeenCalledWith({
      status: 'closed',
      closedDateFrom: new Date('2026-06-01T00:00:00Z'),
      closedDateTo: new Date('2026-06-30T23:59:59Z'),
      symbol: 'SPY',
      strategyId: 10,
      subscriptionId: 20,
      exitProfileId: 30,
      mode: 'paper',
      limit: null,
    });
  });

  it('filters by exit reason and outcome before summaries and groups', async () => {
    mocks.listTradeCycles.mockResolvedValue({
      cycles: [
        cycle({ id: 1, realizedPnl: 10, exitReason: 'target' }),
        cycle({ id: 2, realizedPnl: -5, returnPct: -0.01, exitReason: 'target' }),
        cycle({ id: 3, realizedPnl: 0, returnPct: 0, exitReason: 'target' }),
        cycle({ id: 4, realizedPnl: 30, exitReason: 'manual' }),
      ],
    });

    const result = await getTradePerformance({
      exitReason: 'target',
      outcome: 'breakeven',
    });

    expect(result.summary).toEqual(
      expect.objectContaining({
        tradeCount: 1,
        reportableTradeCount: 1,
        totalRealizedPnl: 0,
      })
    );
    expect(result.trades.map((trade) => trade.id)).toEqual([3]);
    expect(result.groups.byExitReason).toEqual([
      expect.objectContaining({
        id: 'target',
        reportableTradeCount: 1,
      }),
    ]);
  });

  it('paginates rows without changing summary totals', async () => {
    mocks.listTradeCycles.mockResolvedValue({
      cycles: [
        cycle({
          id: 1,
          closedAt: new Date('2026-06-01T16:00:00Z'),
          realizedPnl: 10,
        }),
        cycle({
          id: 2,
          closedAt: new Date('2026-06-02T16:00:00Z'),
          realizedPnl: 20,
        }),
        cycle({
          id: 3,
          closedAt: new Date('2026-06-03T16:00:00Z'),
          realizedPnl: -5,
          returnPct: -0.01,
        }),
      ],
    });

    const result = await getTradePerformance({
      page: 2,
      pageSize: 1,
      sortBy: 'closedAt',
      sortDirection: 'desc',
    });

    expect(result.summary).toEqual(
      expect.objectContaining({
        tradeCount: 3,
        reportableTradeCount: 3,
        totalRealizedPnl: 25,
      })
    );
    expect(result.trades.map((trade) => trade.id)).toEqual([2]);
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 1,
      total: 3,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it('sorts trade rows by whitelisted computed fields', async () => {
    mocks.listTradeCycles.mockResolvedValue({
      cycles: [
        cycle({ id: 1, symbol: 'SPY', realizedPnl: 10 }),
        cycle({ id: 2, symbol: 'QQQ', realizedPnl: 30 }),
        cycle({ id: 3, symbol: 'IWM', realizedPnl: -2, returnPct: -0.01 }),
      ],
    });

    const result = await getTradePerformance({
      sortBy: 'realizedPnl',
      sortDirection: 'asc',
    });

    expect(result.trades.map((trade) => trade.id)).toEqual([3, 1, 2]);
  });

  it('serializes nullable relationships and precise row values', async () => {
    mocks.listTradeCycles.mockResolvedValue({
      cycles: [
        cycle({
          id: 1,
          quantity: 0.12345678,
          avgEntryPrice: 100.123456,
          avgExitPrice: null,
          strategy: null,
          subscription: null,
          exitProfile: null,
          exitReason: null,
        }),
      ],
    });

    const result = await getTradePerformance();

    expect(result.trades[0]).toEqual(
      expect.objectContaining({
        id: 1,
        quantity: 0.12345678,
        avgEntryPrice: 100.123456,
        avgExitPrice: null,
        mode: null,
        strategy: null,
        subscription: null,
        exitProfile: null,
        exitReason: null,
        openedAt: '2026-06-10T14:30:00.000Z',
        closedAt: '2026-06-10T16:00:00.000Z',
      })
    );
  });

  it('returns empty rows and pagination metadata when no trades match', async () => {
    mocks.listTradeCycles.mockResolvedValue({
      cycles: [],
    });

    const result = await getTradePerformance({
      page: 10,
      pageSize: 25,
    });

    expect(result.summary.tradeCount).toBe(0);
    expect(result.trades).toEqual([]);
    expect(result.pagination).toEqual({
      page: 10,
      pageSize: 25,
      total: 0,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });
});
