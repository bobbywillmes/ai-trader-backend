import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  getAccessibleEntryDecisionById: vi.fn(),
  listAccessibleEntryDecisions: vi.fn(),
}));

vi.mock('../services/entry-decision.service.js', () => ({
  getAccessibleEntryDecisionById: mocks.getAccessibleEntryDecisionById,
  listAccessibleEntryDecisions: mocks.listAccessibleEntryDecisions,
}));

import {
  entryDecisionByIdController,
  entryDecisionsController,
} from './entry-decisions.controller.js';

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    locals: { user: { id: 3, platformRole: 'OPERATOR' } },
  };

  res.status.mockReturnValue(res);

  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe('entry decisions controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccessibleEntryDecisions.mockResolvedValue({ decisions: [] });
    mocks.getAccessibleEntryDecisionById.mockResolvedValue({
      decision: {
        id: 101,
      },
    });
  });

  it('passes validated list filters to the service', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await entryDecisionsController(
      {
        query: {
          symbol: 'spy',
          decisionState: 'idle',
          subscriptionId: '22',
          strategyId: '33',
          exitProfileId: '44',
          dateFrom: '2026-06-25T14:00:00.000Z',
          dateTo: '2026-06-25T16:00:00.000Z',
          signalCreated: 'false',
          signalBlocked: 'true',
          limit: '25',
          page: '2',
          pageSize: '50',
          account: '12',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.listAccessibleEntryDecisions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3, platformRole: 'OPERATOR' }),
      12,
      {
      symbol: 'spy',
      decisionState: 'idle',
      subscriptionId: 22,
      strategyId: 33,
      exitProfileId: 44,
      dateFrom: new Date('2026-06-25T14:00:00.000Z'),
      dateTo: new Date('2026-06-25T16:00:00.000Z'),
      signalCreated: false,
      signalBlocked: true,
      limit: 25,
      page: 2,
      pageSize: 50,
      }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects malformed boolean filters', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await entryDecisionsController(
      {
        query: {
          signalCreated: 'yes',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.listAccessibleEntryDecisions).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'signalCreated must be true or false.',
      })
    );
  });

  it('returns entry decision details by id', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await entryDecisionByIdController(
      {
        params: {
          id: '101',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getAccessibleEntryDecisionById).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3, platformRole: 'OPERATOR' }),
      101
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      decision: {
        id: 101,
      },
    });
  });

  it('rejects invalid detail ids', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await entryDecisionByIdController(
      {
        params: {
          id: 'nope',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getAccessibleEntryDecisionById).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid entry decision id.',
      })
    );
  });
});
