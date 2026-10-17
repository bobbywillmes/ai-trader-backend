import { describe, expect, it, vi } from 'vitest';

import { acquireEntryExposureClaim } from './entry-exposure-claim.service.js';

function tx(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    security: { findUnique: vi.fn().mockResolvedValue({ id: 11, symbol: 'SPY' }) },
    entryExposureClaim: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 91 }),
    },
    trackedPosition: { findFirst: vi.fn().mockResolvedValue(null) },
    orderIntent: { findFirst: vi.fn().mockResolvedValue(null) },
    ...overrides,
  } as never;
}

describe('entry exposure admission claim', () => {
  it('creates the intent and claim under the same transaction owner', async () => {
    const db = tx();
    const createIntent = vi.fn().mockResolvedValue({ id: 51 });
    const result = await acquireEntryExposureClaim({
      tx: db, tradingAccountId: 1, symbol: 'spy', ownerKey: 'entry:1:stable', createIntent,
    });
    expect(result).toEqual({ intent: { id: 51 }, duplicate: false, claimId: 91 });
    expect(createIntent).toHaveBeenCalledTimes(1);
    expect((db as any).entryExposureClaim.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tradingAccountId: 1, securityId: 11, orderIntentId: 51, ownerKey: 'entry:1:stable' }),
    });
  });

  it('returns the original lifecycle for a retry even after release', async () => {
    const originalIntent = { id: 51 };
    const db = tx({
      entryExposureClaim: {
        findUnique: vi.fn().mockResolvedValue({ id: 91, releasedAt: new Date(), orderIntent: originalIntent }),
        findFirst: vi.fn(), create: vi.fn(),
      },
    });
    const createIntent = vi.fn();
    await expect(acquireEntryExposureClaim({
      tx: db, tradingAccountId: 1, symbol: 'SPY', ownerKey: 'entry:1:stable', createIntent,
    })).resolves.toEqual({ intent: originalIntent, duplicate: true, claimId: 91 });
    expect(createIntent).not.toHaveBeenCalled();
  });

  it('rejects a competing strategy while another entry owns the symbol', async () => {
    const db = tx({
      entryExposureClaim: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue({
          id: 91, ownerKey: 'entry:1:first', status: 'ENTRY_PENDING', orderIntentId: 51,
          trackedPositionId: null, orderIntent: { id: 51 }, trackedPosition: null,
        }),
        create: vi.fn(),
      },
    });
    await expect(acquireEntryExposureClaim({
      tx: db, tradingAccountId: 1, symbol: 'SPY', ownerKey: 'entry:1:second', createIntent: vi.fn(),
    })).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code: 'ENTRY_ALREADY_PENDING' }) });
  });

  it('fails closed on an uncovered pre-claim lifecycle', async () => {
    const db = tx({
      orderIntent: { findFirst: vi.fn().mockResolvedValue({ id: 44, status: 'submitting', clientOrderId: 'legacy' }) },
    });
    await expect(acquireEntryExposureClaim({
      tx: db, tradingAccountId: 1, symbol: 'SPY', ownerKey: 'entry:1:new', createIntent: vi.fn(),
    })).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code: 'ENTRY_EXPOSURE_UNRESOLVED' }) });
  });
});
