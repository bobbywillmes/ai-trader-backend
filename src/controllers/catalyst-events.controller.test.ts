import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runMassiveNewsWorkerOnce: vi.fn(),
}));

vi.mock('../workers/massive-news.worker.js', () => ({
  runMassiveNewsWorkerOnce: mocks.runMassiveNewsWorkerOnce,
}));

import { runMassiveNewsWorkerOnceController } from './catalyst-events.controller.js';

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

describe('catalyst events controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs one Massive news worker cycle for manual admin testing', async () => {
    const result = {
      skipped: false,
      pulledSymbols: 1,
      processedArticles: 1,
    };
    const res = response();
    const next = vi.fn() as NextFunction;

    mocks.runMassiveNewsWorkerOnce.mockResolvedValue(result);

    await runMassiveNewsWorkerOnceController({} as Request, res, next);

    expect(mocks.runMassiveNewsWorkerOnce).toHaveBeenCalledWith({
      enabled: true,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      result,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards Massive news worker errors to Express error handling', async () => {
    const error = new Error('worker failed');
    const res = response();
    const next = vi.fn() as NextFunction;

    mocks.runMassiveNewsWorkerOnce.mockRejectedValue(error);

    await runMassiveNewsWorkerOnceController({} as Request, res, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
