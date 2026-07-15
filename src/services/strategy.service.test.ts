import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  strategyFindMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    strategy: {
      findMany: mocks.strategyFindMany,
    },
  },
}));

import { getStrategies } from './strategy.service.js';

describe('strategy service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves the existing raw strategy list and key sorting', async () => {
    const strategies = [
      {
        id: 1,
        key: 'momentum_etf',
        name: 'Momentum ETF',
        description: null,
        allowedSymbolsJson: ['SPY'],
        enabled: false,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-02T00:00:00.000Z'),
      },
    ];
    mocks.strategyFindMany.mockResolvedValue(strategies);

    await expect(getStrategies()).resolves.toBe(strategies);
    expect(mocks.strategyFindMany).toHaveBeenCalledWith({
      orderBy: { key: 'asc' },
    });
  });
});
