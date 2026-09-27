import { afterEach, describe, expect, it, vi } from 'vitest';
import { corsOptions } from '../config/cors.js';
import { exportFilename } from './security-universe.controller.js';

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
