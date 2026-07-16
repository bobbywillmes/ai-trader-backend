import { MomentumCandidateState } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    momentumCandidate: {
      count: mocks.count,
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
  },
}));

import { expireStaleMomentumCandidates } from './momentum-candidate-expiration.service.js';

describe('momentum candidate expiration service', () => {
  const now = new Date('2026-07-16T14:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.count.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    mocks.findMany.mockResolvedValue([
      { id: 'stale', expiresAt: new Date('2026-07-16T14:00:00.000Z') },
      { id: 'recent', expiresAt: new Date('2026-07-16T15:00:00.000Z') },
    ]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('expires at the exact boundary and preserves recent active candidates', async () => {
    await expect(expireStaleMomentumCandidates({ now, limit: 25 })).resolves.toEqual({
      inspected: 2,
      expired: 1,
      unchanged: 1,
      skipped: 0,
      staleRemaining: 0,
      expiredCandidateIds: ['stale'],
      expiredCandidateIdsTruncated: false,
      reasonCounts: { EXPIRES_AT_REACHED: 1 },
      asOf: now,
    });

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['stale'] },
        state: { in: [
          MomentumCandidateState.DISCOVERED,
          MomentumCandidateState.WATCHING,
          MomentumCandidateState.ENTRY_READY,
          MomentumCandidateState.ENTRY_BLOCKED,
        ] },
        expiresAt: { lte: now },
      },
      data: { state: MomentumCandidateState.EXPIRED, lastEvaluatedAt: now },
    });
  });

  it('is idempotent when no stale active candidates remain', async () => {
    mocks.count.mockReset().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mocks.findMany.mockResolvedValue([
      { id: 'recent', expiresAt: new Date('2026-07-16T15:00:00.000Z') },
    ]);

    await expect(expireStaleMomentumCandidates({ now })).resolves.toMatchObject({
      inspected: 1,
      expired: 0,
      unchanged: 1,
      staleRemaining: 0,
      reasonCounts: {},
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('reports candidates beyond the bounded inspection as skipped', async () => {
    mocks.count.mockReset().mockResolvedValueOnce(12).mockResolvedValueOnce(3);

    await expect(expireStaleMomentumCandidates({ now, limit: 2 })).resolves.toMatchObject({
      inspected: 2,
      skipped: 10,
      staleRemaining: 3,
    });
  });
});
