import { MomentumScannerHandoffStatus } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMomentumScannerHandoffById: vi.fn(),
  listMomentumScannerHandoffs: vi.fn(),
  markMomentumScannerHandoffAcknowledged: vi.fn(),
  markMomentumScannerHandoffFailed: vi.fn(),
  markMomentumScannerHandoffSent: vi.fn(),
  prepareReadyMomentumScannerHandoffs: vi.fn(),
}));

vi.mock('../services/momentum-scanner-handoff.service.js', () => ({
  getMomentumScannerHandoffById: mocks.getMomentumScannerHandoffById,
  listMomentumScannerHandoffs: mocks.listMomentumScannerHandoffs,
  markMomentumScannerHandoffAcknowledged:
    mocks.markMomentumScannerHandoffAcknowledged,
  markMomentumScannerHandoffFailed: mocks.markMomentumScannerHandoffFailed,
  markMomentumScannerHandoffSent: mocks.markMomentumScannerHandoffSent,
  prepareReadyMomentumScannerHandoffs:
    mocks.prepareReadyMomentumScannerHandoffs,
}));

import {
  acknowledgeMomentumScannerHandoffController,
  getMomentumScannerHandoffController,
  listMomentumScannerHandoffsController,
  markMomentumScannerHandoffFailedController,
  markMomentumScannerHandoffSentController,
  prepareMomentumScannerHandoffsController,
} from './momentum-scanner-handoffs.controller.js';

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

describe('momentum scanner handoffs controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMomentumScannerHandoffs.mockResolvedValue([{ id: 'handoff-1' }]);
    mocks.getMomentumScannerHandoffById.mockResolvedValue({ id: 'handoff-1' });
    mocks.prepareReadyMomentumScannerHandoffs.mockResolvedValue({
      prepared: 1,
      skipped: 0,
      handoffs: [{ id: 'handoff-1' }],
      skippedReasons: [],
    });
    mocks.markMomentumScannerHandoffSent.mockResolvedValue({
      id: 'handoff-1',
      status: MomentumScannerHandoffStatus.SENT,
    });
    mocks.markMomentumScannerHandoffAcknowledged.mockResolvedValue({
      id: 'handoff-1',
      status: MomentumScannerHandoffStatus.ACKNOWLEDGED,
    });
    mocks.markMomentumScannerHandoffFailed.mockResolvedValue({
      id: 'handoff-1',
      status: MomentumScannerHandoffStatus.FAILED,
    });
  });

  it('passes validated list filters to the service', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listMomentumScannerHandoffsController(
      {
        query: {
          candidateId: 'candidate-1',
          symbol: 'mu',
          status: MomentumScannerHandoffStatus.PENDING,
          limit: '25',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.listMomentumScannerHandoffs).toHaveBeenCalledWith({
      candidateId: 'candidate-1',
      symbol: 'mu',
      status: MomentumScannerHandoffStatus.PENDING,
      limit: 25,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([{ id: 'handoff-1' }]);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects unsupported handoff statuses', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listMomentumScannerHandoffsController(
      {
        query: {
          status: 'READY',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.listMomentumScannerHandoffs).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'status is not supported.',
      })
    );
  });

  it('prepares a bounded handoff batch with optional overrides', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await prepareMomentumScannerHandoffsController(
      {
        body: {
          candidateId: 'candidate-1',
          maxCandidates: 5,
          minScore: 85,
          force: true,
          now: '2026-07-04T16:00:00.000Z',
          payloadVersion: 'v1',
        },
      } as Request,
      res,
      next
    );

    expect(mocks.prepareReadyMomentumScannerHandoffs).toHaveBeenCalledWith({
      candidateId: 'candidate-1',
      maxCandidates: 5,
      minScore: 85,
      force: true,
      now: new Date('2026-07-04T16:00:00.000Z'),
      payloadVersion: 'v1',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns one handoff by id', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getMomentumScannerHandoffController(
      {
        params: {
          id: ' handoff-1 ',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getMomentumScannerHandoffById).toHaveBeenCalledWith(
      'handoff-1'
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('marks sent and acknowledged with optional metadata', async () => {
    const now = '2026-07-04T16:00:00.000Z';
    const metadata = {
      workflowRunId: 'n8n-run-1',
    };
    const sentRes = response();
    const acknowledgedRes = response();
    const next = vi.fn() as NextFunction;

    await markMomentumScannerHandoffSentController(
      {
        params: {
          id: 'handoff-1',
        },
        body: {
          now,
          metadata,
        },
      } as unknown as Request,
      sentRes,
      next
    );
    await acknowledgeMomentumScannerHandoffController(
      {
        params: {
          id: 'handoff-1',
        },
        body: {
          now,
          metadata,
        },
      } as unknown as Request,
      acknowledgedRes,
      next
    );

    expect(mocks.markMomentumScannerHandoffSent).toHaveBeenCalledWith(
      'handoff-1',
      {
        now: new Date(now),
        metadata,
      }
    );
    expect(mocks.markMomentumScannerHandoffAcknowledged).toHaveBeenCalledWith(
      'handoff-1',
      {
        now: new Date(now),
        metadata,
      }
    );
  });

  it('requires an error message when marking failed', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await markMomentumScannerHandoffFailedController(
      {
        params: {
          id: 'handoff-1',
        },
        body: {},
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.markMomentumScannerHandoffFailed).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'error must be a non-empty string.',
      })
    );
  });

  it('marks failed with sanitized request options', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await markMomentumScannerHandoffFailedController(
      {
        params: {
          id: 'handoff-1',
        },
        body: {
          error: 'n8n delivery failed',
          now: '2026-07-04T16:00:00.000Z',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.markMomentumScannerHandoffFailed).toHaveBeenCalledWith(
      'handoff-1',
      'n8n delivery failed',
      {
        now: new Date('2026-07-04T16:00:00.000Z'),
      }
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
