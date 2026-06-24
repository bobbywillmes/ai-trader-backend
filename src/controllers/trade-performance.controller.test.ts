import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  getTradePerformance: vi.fn(),
}));

vi.mock('../services/trade-performance.service.js', () => ({
  getTradePerformance: mocks.getTradePerformance,
}));

import { tradePerformanceController } from './trade-performance.controller.js';

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
}

describe('trade performance controller', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes validated query parameters to the service', async () => {
    mocks.getTradePerformance.mockResolvedValue({ ok: true });
    const req = {
      query: {
        dateFrom: '2026-06-01T00:00:00Z',
        dateTo: '2026-06-30T23:59:59Z',
        symbol: 'spy',
        strategyId: '1',
        subscriptionId: '2',
        exitProfileId: '3',
        exitReason: 'target',
        outcome: 'winner',
        mode: 'paper',
        page: '2',
        pageSize: '25',
        sortBy: 'realizedPnl',
        sortDirection: 'asc',
      },
    } as unknown as Request;
    const res = response();
    const next = vi.fn() as NextFunction;

    await tradePerformanceController(req, res, next);

    expect(mocks.getTradePerformance).toHaveBeenCalledWith({
      dateFrom: new Date('2026-06-01T00:00:00Z'),
      dateTo: new Date('2026-06-30T23:59:59Z'),
      symbol: 'spy',
      strategyId: 1,
      subscriptionId: 2,
      exitProfileId: 3,
      exitReason: 'target',
      outcome: 'winner',
      mode: 'paper',
      page: 2,
      pageSize: 25,
      sortBy: 'realizedPnl',
      sortDirection: 'asc',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects malformed query parameters', async () => {
    const req = {
      query: {
        sortBy: 'rawSql',
      },
    } as unknown as Request;
    const res = response();
    const next = vi.fn() as NextFunction;

    await tradePerformanceController(req, res, next);

    expect(mocks.getTradePerformance).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'sortBy is not supported.',
      })
    );
  });
});
