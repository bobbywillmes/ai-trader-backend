import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { corsOptions } from '../config/cors.js';
import { exportFilename, importController } from './security-universe.controller.js';

afterEach(() => vi.useRealTimers());

describe('Security CSV export response contract', () => {
  it('uses UTC millisecond filenames that are unique and Windows-safe', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T16:52:41.384Z'));
    expect(exportFilename('universe-snapshot')).toBe('universe-snapshot-2026-09-27T16-52-41-384Z.csv');
    expect(exportFilename('security-catalog')).toBe('security-catalog-2026-09-27T16-52-41-385Z.csv');
  });
  it('exposes Content-Disposition to an allowed cross-origin frontend', () => {
    expect(corsOptions.exposedHeaders).toContain('Content-Disposition');
  });
});

describe('Security universe HTTP timing contract', () => {
  it('rejects arbitrary historical effectiveDate instead of treating it as immediate', async () => {
    const req = { body: { csv: 'symbol\nAAPL\n', effectiveDate: '2026-01-01' } } as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn() as NextFunction;
    await importController(false)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid import request.' }));
    expect(next).not.toHaveBeenCalled();
  });
  it('rejects the retired mode field instead of silently changing import behavior', async () => {
    const req = { body: { csv: 'symbol\nAAPL\n', mode: 'snapshot' } } as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn() as NextFunction;
    await importController(false)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
