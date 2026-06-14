import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listTradeCycles: vi.fn(),
}));

vi.mock('./trade-cycles.service.js', () => ({
  listTradeCycles: mocks.listTradeCycles,
}));

import { getTradePerformance } from './trade-performance.service.js';

function cycle(overrides: Record<string, unknown>) {
  return {
    id: 1,
    symbol: 'SPY',
    closedAt: new Date('2026-06-10T16:00:00Z'),
    realizedPnl: 10,
    returnPct: 0.02,
    holdingDurationMs: 60_000,
    strategy: { id: 1, key: 'strategy_a', name: 'Strategy A' },
    subscription: { id: 1, key: 'sub_a', name: 'Sub A' },
    exitProfile: { id: 1, key: 'exit_a', name: 'Exit A' },
    exitReason: 'target',
    ...overrides,
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
          subscription: { id: 2, key: 'sub_b', name: 'Sub B' },
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
      limit: 500,
    });

    expect(mocks.listTradeCycles).toHaveBeenCalledWith({
      status: 'closed',
      mode: 'paper',
      limit: 500,
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

  it('applies date filters to closed cycle timestamps', async () => {
    mocks.listTradeCycles.mockResolvedValue({
      cycles: [
        cycle({
          id: 1,
          symbol: 'SPY',
          closedAt: new Date('2026-06-10T16:00:00Z'),
          realizedPnl: 20,
        }),
        cycle({
          id: 2,
          symbol: 'QQQ',
          closedAt: new Date('2026-05-10T16:00:00Z'),
          realizedPnl: 30,
        }),
      ],
    });

    const result = await getTradePerformance({
      dateFrom: new Date('2026-06-01T00:00:00Z'),
    });

    expect(mocks.listTradeCycles).toHaveBeenCalledWith({
      status: 'closed',
      limit: 1000,
    });
    expect(result.summary).toEqual(
      expect.objectContaining({
        tradeCount: 1,
        reportableTradeCount: 1,
        totalRealizedPnl: 20,
      })
    );
  });
});
