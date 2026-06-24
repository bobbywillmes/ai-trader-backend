import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  getAccountSnapshotTrends: vi.fn(),
  getLatestAccountSnapshot: vi.fn(),
  getRecentAccountSnapshots: vi.fn(),
  recordAccountSnapshot: vi.fn(),
}));

vi.mock('../services/account-snapshot.service.js', () => ({
  getAccountSnapshotTrends: mocks.getAccountSnapshotTrends,
  getLatestAccountSnapshot: mocks.getLatestAccountSnapshot,
  getRecentAccountSnapshots: mocks.getRecentAccountSnapshots,
  recordAccountSnapshot: mocks.recordAccountSnapshot,
}));

import { getAccountSnapshotTrendsController } from './account-snapshots.controller.js';

function request(query: Request['query']): Request {
  return { query } as Request;
}

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };

  res.status.mockReturnValue(res);

  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe('account snapshots controller', () => {
  const next: NextFunction = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccountSnapshotTrends.mockResolvedValue({
      generatedAt: '2026-06-24T15:00:00.000Z',
      filters: {
        dateFrom: null,
        dateTo: null,
        mode: null,
        limit: 500,
      },
      snapshots: [],
    });
  });

  it('rejects malformed trend date filters', async () => {
    const res = response();

    await getAccountSnapshotTrendsController(
      request({ dateFrom: 'not-a-date' }),
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'ValidationError',
      message: 'Invalid dateFrom query parameter.',
    });
    expect(mocks.getAccountSnapshotTrends).not.toHaveBeenCalled();
  });

  it('rejects unsupported trend modes', async () => {
    const res = response();

    await getAccountSnapshotTrendsController(
      request({ mode: 'sandbox' }),
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'ValidationError',
      message: 'Unsupported account snapshot mode.',
    });
    expect(mocks.getAccountSnapshotTrends).not.toHaveBeenCalled();
  });
});
