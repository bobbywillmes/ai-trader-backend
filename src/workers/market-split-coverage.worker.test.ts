import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ extend: vi.fn(), event: vi.fn() }));
vi.mock('../services/market-split-bootstrap.service.js', () => ({ extendMarketSplitCoverage: mocks.extend }));
vi.mock('../db/prisma.js', () => ({ prisma: { systemEvent: { create: mocks.event } } }));
import { runMarketSplitCoverageWorker } from './market-split-coverage.worker.js';

describe('automatic Massive split coverage worker', () => {
  beforeEach(() => vi.resetAllMocks());
  it('reports Tiingo authority as an expected dormant tick', async () => {
    mocks.extend.mockResolvedValue({ dormant: true, reason: 'tiingo_authority', extended: 0 });
    await expect(runMarketSplitCoverageWorker()).resolves.toEqual({ outcome: 'skipped', skipReason: 'not_due' });
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it('reports immutable coverage extension as successful work', async () => {
    mocks.extend.mockResolvedValue({ dormant: false, extended: 5 });
    await expect(runMarketSplitCoverageWorker()).resolves.toEqual({ outcome: 'success', workSucceeded: true });
  });
  it('persists an operational event and rethrows failures for Worker Health', async () => {
    mocks.extend.mockRejectedValue(new Error('strict provider failure'));
    mocks.event.mockResolvedValue({});
    await expect(runMarketSplitCoverageWorker()).rejects.toThrow('strict provider failure');
    expect(mocks.event).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'market_split_coverage_extension_failed', severity: 'ERROR' }) });
  });
});
