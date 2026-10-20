import { describe, expect, it, vi } from 'vitest';

import { acquireEntryExposureClaim, attachEntryExposureClaimToPosition, releaseUnsubmittedEntryExposureClaim, transitionEntryExposureClaim } from './entry-exposure-claim.service.js';

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
    brokerOrder: { findFirst: vi.fn().mockResolvedValue(null) },
    entryExposureClaimEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    ...overrides,
  } as never;
}

describe('entry exposure admission claim', () => {
  it.each([
    'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:timeout after fetch',
    'BROKER_WRITE_DELIVERY:BROKER_REJECTED:Alpaca status 408',
    'BROKER_WRITE_DELIVERY:BROKER_REJECTED:Alpaca status 409',
  ])('shared unsubmitted release boundary rejects ambiguous delivery evidence: %s', async (blockReason) => {
    const updateMany = vi.fn();
    const db = {
      entryExposureClaim: {
        findUnique: vi.fn().mockResolvedValue({
          id: 91, orderIntentId: 51, trackedPositionId: null, status: 'ENTRY_SUBMITTING', releasedAt: null,
          orderIntent: { blockReason },
        }),
        updateMany,
      },
      brokerOrder: { count: vi.fn().mockResolvedValue(0) },
      brokerActivity: { count: vi.fn().mockResolvedValue(0) },
      orderIntentBrokerOpportunityEvent: { count: vi.fn().mockResolvedValue(0) },
      marketPolicyBrokerDispatchConsumption: { count: vi.fn().mockResolvedValue(0) },
      marketPolicyBrokerUnenforcedDispatch: { count: vi.fn().mockResolvedValue(0) },
      trackedPosition: { findUnique: vi.fn() },
      entryExposureClaimEvent: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    } as never;

    await expect(releaseUnsubmittedEntryExposureClaim({ orderIntentId: 51, reason: 'UNSAFE', db }))
      .rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code: 'ENTRY_EXPOSURE_UNRESOLVED' }) });
    expect(updateMany).not.toHaveBeenCalled();
  });

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

  it.each(['received', 'accepted', 'pending_new', 'accepted_for_bidding', 'held', 'pending_cancel', 'pending_replace', 'partially_filled'])(
    'fails closed on a claimless broker-active BUY in %s', async (status) => {
      const db = tx({
        brokerOrder: { findFirst: vi.fn().mockResolvedValue({ id: 7, orderIntentId: 44, brokerOrderId: 'legacy-buy', status }) },
      });
      await expect(acquireEntryExposureClaim({
        tx: db, tradingAccountId: 1, symbol: 'SPY', ownerKey: `entry:1:${status}`, createIntent: vi.fn(),
      })).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code: 'ENTRY_EXPOSURE_UNRESOLVED' }) });
    },
  );

  it('retains a conflicting old claim as unresolved without throwing position creation away', async () => {
    const update = vi.fn().mockResolvedValue({ id: 91, status: 'UNRESOLVED', trackedPositionId: 70 });
    const db = tx({
      entryExposureClaim: {
        findFirst: vi.fn().mockResolvedValue({ id: 91, status: 'POSITION_OPEN', trackedPositionId: 70 }),
        update,
      },
      entryExposureClaimEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(attachEntryExposureClaimToPosition({
      tx: db, tradingAccountId: 1, securityId: 11, trackedPositionId: 71, symbol: 'SPY',
    })).resolves.toMatchObject({ status: 'UNRESOLVED', trackedPositionId: 70 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 91 },
      data: expect.objectContaining({ status: 'UNRESOLVED' }),
    }));
  });

  it('does not permit ordinary recovery out of unresolved or append unchanged transitions', async () => {
    const update = vi.fn();
    const db = {
      entryExposureClaim: {
        findUnique: vi.fn().mockResolvedValue({ id: 91, orderIntentId: 51, status: 'UNRESOLVED', releasedAt: null }),
        update,
      },
      entryExposureClaimEvent: { findFirst: vi.fn().mockResolvedValue({ evidenceJson: {} }) },
    } as never;
    await expect(transitionEntryExposureClaim({
      orderIntentId: 51, status: 'ENTRY_PENDING', eventType: 'UNSAFE_RECOVERY', db,
    })).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code: 'INVALID_ENTRY_EXPOSURE_TRANSITION' }) });
    await expect(transitionEntryExposureClaim({
      orderIntentId: 51, status: 'UNRESOLVED', eventType: 'REPEATED_OBSERVATION', db,
    })).resolves.toMatchObject({ id: 91 });
    expect(update).not.toHaveBeenCalled();
  });
});
