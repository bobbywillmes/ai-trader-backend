import { MomentumCandidateState } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmActiveCandidates: vi.fn(),
  confirmCandidatePrice: vi.fn(),
  expireStaleMomentumCandidates: vi.fn(),
  generateMomentumCandidatesFromCatalysts: vi.fn(),
  getMomentumCandidateById: vi.fn(),
  listMomentumCandidatePriceChecks: vi.fn(),
  listMomentumCandidates: vi.fn(),
}));

vi.mock('../services/momentum-candidates.service.js', () => ({
  expireStaleMomentumCandidates: mocks.expireStaleMomentumCandidates,
  generateMomentumCandidatesFromCatalysts:
    mocks.generateMomentumCandidatesFromCatalysts,
  getMomentumCandidateById: mocks.getMomentumCandidateById,
  listMomentumCandidates: mocks.listMomentumCandidates,
}));

vi.mock('../services/momentum-price-confirmation.service.js', () => ({
  confirmActiveCandidates: mocks.confirmActiveCandidates,
  confirmCandidatePrice: mocks.confirmCandidatePrice,
  listMomentumCandidatePriceChecks: mocks.listMomentumCandidatePriceChecks,
}));

import {
  confirmMomentumCandidatePriceController,
  confirmMomentumCandidatePricesController,
  expireStaleMomentumCandidatesController,
  generateMomentumCandidatesController,
  getMomentumCandidateController,
  listMomentumCandidatePriceChecksController,
  listMomentumCandidatesController,
} from './momentum-candidates.controller.js';

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn((payload: unknown) => JSON.stringify(payload)),
  };

  res.status.mockReturnValue(res);

  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe('momentum candidates controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMomentumCandidates.mockResolvedValue([{ id: 'candidate-1' }]);
    mocks.getMomentumCandidateById.mockResolvedValue({ id: 'candidate-1' });
    mocks.generateMomentumCandidatesFromCatalysts.mockResolvedValue({
      generatedCandidates: 1,
    });
    mocks.expireStaleMomentumCandidates.mockResolvedValue({ expired: 2 });
    mocks.confirmCandidatePrice.mockResolvedValue({
      candidate: {
        id: 'candidate-1',
        rawSnapshot: {
          priceConfirmation: {
            dayVolume: 1_234_567n,
            recentVolume: 12_345n,
          },
        },
      },
      priceCheck: {
        id: 'price-check-1',
        dayVolume: 1_234_567n,
        recentVolume: 12_345n,
        rawPayload: {
          nestedVolume: 500n,
        },
        metadata: {
          nestedVolume: 600n,
        },
      },
    });
    mocks.confirmActiveCandidates.mockResolvedValue({
      evaluated: 1,
      entryReady: 1,
      watching: 0,
      blocked: 0,
      skipped: 0,
      errors: [],
      results: [
        {
          skipped: false,
          candidate: {
            id: 'candidate-1',
            rawSnapshot: {
              priceConfirmation: {
                dayVolume: 1_234_567n,
                recentVolume: 12_345n,
              },
            },
          },
          priceCheck: {
            id: 'price-check-1',
            dayVolume: 1_234_567n,
            recentVolume: 12_345n,
            rawPayload: {
              nestedVolume: 500n,
            },
            metadata: {
              nestedVolume: 600n,
            },
          },
        },
      ],
    });
    mocks.listMomentumCandidatePriceChecks.mockResolvedValue([
      {
        id: 'price-check-1',
        dayVolume: 1_234_567n,
        recentVolume: null,
        rawPayload: {
          nestedVolume: 500n,
        },
        metadata: {
          nestedVolume: 600n,
        },
      },
    ]);
  });

  it('passes validated list filters to the service', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listMomentumCandidatesController(
      {
        query: {
          symbol: 'aapl',
          state: MomentumCandidateState.WATCHING,
          limit: '25',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.listMomentumCandidates).toHaveBeenCalledWith({
      symbol: 'aapl',
      state: MomentumCandidateState.WATCHING,
      limit: 25,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([{ id: 'candidate-1' }]);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects unsupported candidate states', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listMomentumCandidatesController(
      {
        query: {
          state: 'ACTIVE',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.listMomentumCandidates).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'state is not supported.',
      })
    );
  });

  it('returns candidate details by id', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getMomentumCandidateController(
      {
        params: {
          id: ' candidate-1 ',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getMomentumCandidateById).toHaveBeenCalledWith('candidate-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id: 'candidate-1' });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes generation options to the service', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await generateMomentumCandidatesController(
      {
        body: {
          minCatalystScore: 70,
          expiresInHours: 12,
          take: 50,
          recentSince: '2026-07-04T12:00:00.000Z',
        },
      } as Request,
      res,
      next
    );

    expect(mocks.generateMomentumCandidatesFromCatalysts).toHaveBeenCalledWith({
      minCatalystScore: 70,
      expiresInHours: 12,
      take: 50,
      recentSince: new Date('2026-07-04T12:00:00.000Z'),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      generatedCandidates: 1,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid generation numbers', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await generateMomentumCandidatesController(
      {
        body: {
          minCatalystScore: 0,
        },
      } as Request,
      res,
      next
    );

    expect(mocks.generateMomentumCandidatesFromCatalysts).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'minCatalystScore must be a positive integer.',
      })
    );
  });

  it('expires stale candidates using an optional as-of timestamp', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await expireStaleMomentumCandidatesController(
      {
        body: {
          now: '2026-07-05T15:00:00.000Z',
        },
      } as Request,
      res,
      next
    );

    expect(mocks.expireStaleMomentumCandidates).toHaveBeenCalledWith({
      now: new Date('2026-07-05T15:00:00.000Z'),
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ expired: 2 });
    expect(next).not.toHaveBeenCalled();
  });

  it('confirms price for one candidate with optional timing overrides', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await confirmMomentumCandidatePriceController(
      {
        params: {
          id: ' candidate-1 ',
        },
        body: {
          now: '2026-07-04T15:30:00.000Z',
          recentWindowMinutes: 15,
          lookbackMinutes: 120,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.confirmCandidatePrice).toHaveBeenCalledWith('candidate-1', {
      now: new Date('2026-07-04T15:30:00.000Z'),
      recentWindowMinutes: 15,
      lookbackMinutes: 120,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      candidate: {
        id: 'candidate-1',
        rawSnapshot: {
          priceConfirmation: {
            dayVolume: '1234567',
            recentVolume: '12345',
          },
        },
      },
      priceCheck: {
        id: 'price-check-1',
        dayVolume: '1234567',
        recentVolume: '12345',
        rawPayload: {
          nestedVolume: '500',
        },
        metadata: {
          nestedVolume: '600',
        },
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('confirms a bounded batch of active candidates', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await confirmMomentumCandidatePricesController(
      {
        body: {
          maxCandidates: 5,
          minCatalystScore: 75,
          state: MomentumCandidateState.WATCHING,
          now: '2026-07-04T15:30:00.000Z',
        },
      } as Request,
      res,
      next
    );

    expect(mocks.confirmActiveCandidates).toHaveBeenCalledWith({
      now: new Date('2026-07-04T15:30:00.000Z'),
      maxCandidates: 5,
      minCatalystScore: 75,
      state: MomentumCandidateState.WATCHING,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      evaluated: 1,
      entryReady: 1,
      watching: 0,
      blocked: 0,
      skipped: 0,
      errors: [],
      results: [
        {
          skipped: false,
          candidate: {
            id: 'candidate-1',
            rawSnapshot: {
              priceConfirmation: {
                dayVolume: '1234567',
                recentVolume: '12345',
              },
            },
          },
          priceCheck: {
            id: 'price-check-1',
            dayVolume: '1234567',
            recentVolume: '12345',
            rawPayload: {
              nestedVolume: '500',
            },
            metadata: {
              nestedVolume: '600',
            },
          },
        },
      ],
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('lists recent candidate price checks newest first', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listMomentumCandidatePriceChecksController(
      {
        params: {
          id: 'candidate-1',
        },
        query: {
          limit: '10',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.listMomentumCandidatePriceChecks).toHaveBeenCalledWith(
      'candidate-1',
      {
        limit: 10,
      }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([
      {
        id: 'price-check-1',
        dayVolume: '1234567',
        recentVolume: null,
        rawPayload: {
          nestedVolume: '500',
        },
        metadata: {
          nestedVolume: '600',
        },
      },
    ]);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid batch confirmation states', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await confirmMomentumCandidatePricesController(
      {
        body: {
          state: 'ACTIVE',
        },
      } as Request,
      res,
      next
    );

    expect(mocks.confirmActiveCandidates).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'state is not supported.',
      })
    );
  });
});
