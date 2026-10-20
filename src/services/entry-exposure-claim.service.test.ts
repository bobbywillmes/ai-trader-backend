import { describe, expect, it, vi } from 'vitest';

import { acquireEntryExposureClaim, attachEntryExposureClaimToPosition, releasedByThisCall, releaseUnsubmittedEntryExposureClaim, transitionEntryExposureClaim } from './entry-exposure-claim.service.js';

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
  function releaseDb(claim: Record<string, unknown>, events: Array<{ id: number; eventType: string; evidenceJson: unknown }> = [], counts: Record<string, number> = {}) {
    const calls: string[] = [];
    const updateMany = vi.fn(async () => { calls.push('compare-and-set'); return { count: counts.casCount ?? 1 }; });
    const db = {
      $queryRaw: vi.fn(async () => { calls.push('entry-exposure-lock'); return [{}]; }),
      entryExposureClaim: {
        findUnique: vi.fn().mockResolvedValue({ id: 91, orderIntentId: 51, tradingAccountId: 7, securityId: 8, trackedPositionId: null, releasedAt: null, orderIntent: { blockReason: null }, ...claim }),
        updateMany,
      },
      brokerOrder: { count: vi.fn().mockResolvedValue(counts.brokerOrders ?? 0) },
      brokerActivity: { count: vi.fn().mockResolvedValue(0) },
      orderIntentBrokerOpportunityEvent: { count: vi.fn().mockResolvedValue(0) },
      marketPolicyBrokerDispatchConsumption: { count: vi.fn().mockResolvedValue(counts.consumptions ?? 0) },
      marketPolicyBrokerUnenforcedDispatch: { count: vi.fn().mockResolvedValue(0) },
      liveEntryArmingTermination: { count: vi.fn().mockResolvedValue(counts.liveArming ?? 0) },
      trackedPosition: { findUnique: vi.fn() },
      entryExposureClaimEvent: { findMany: vi.fn().mockResolvedValue(events.map((event) => ({ createdAt: new Date(), ...event }))), create: vi.fn() },
    };
    return { db: db as never, updateMany, calls };
  }
  const notSent = (id: number, classification = 'NOT_SENT_PRE_DISPATCH') => ({ id, eventType: 'NOT_SENT_EVIDENCE_RECORDED', evidenceJson: { classification } });
  const outcome = (id: number, classification: string, statusCode: number | null = null) => ({ id, eventType: 'DISPATCH_OUTCOME_RECORDED', evidenceJson: { classification, statusCode, source: 'WORKER' } });
  const marker = (id: number) => ({ id, eventType: 'ADAPTER_INVOCATION_STARTED', evidenceJson: {} });

  it.each([
    ['a DELIVERY_UNCERTAIN block reason', { orderIntent: { blockReason: 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:timeout after fetch' } }, [notSent(1)], {}],
    ['a BROKER_REJECTED 408 block reason', { orderIntent: { blockReason: 'BROKER_WRITE_DELIVERY:BROKER_REJECTED:Alpaca status 408' } }, [notSent(1)], {}],
    ['a recorded 409 rejection', {}, [notSent(1), outcome(2, 'BROKER_REJECTED', 409)], {}],
    ['a recorded definitive 422 rejection', {}, [notSent(1), outcome(2, 'BROKER_REJECTED', 422)], {}],
    ['a recorded delivery-uncertain outcome', {}, [outcome(1, 'DELIVERY_UNCERTAIN')], {}],
    ['an inferred unknown outcome', {}, [{ id: 1, eventType: 'DISPATCH_OUTCOME_RECORDED', evidenceJson: { classification: 'DISPATCH_OUTCOME_UNKNOWN', source: 'TERMINAL_CLAIM_SWEEP' } }], {}],
    ['an entered boundary without a closing record (crash)', {}, [marker(1)], {}],
    ['an ENTRY_SUBMITTING claim without recorded not-sent evidence', {}, [], {}],
    ['a consumed LIVE one-shot arming', {}, [notSent(1)], { liveArming: 1 }],
    ['a dispatch consumption', {}, [notSent(1)], { consumptions: 1 }],
  ] as const)('shared never-submitted release refuses %s under the entry-exposure lock', async (_label, claim, events, counts) => {
    const { db, updateMany, calls } = releaseDb({ status: 'ENTRY_SUBMITTING', ...claim }, [...events], counts);
    await expect(releaseUnsubmittedEntryExposureClaim({ orderIntentId: 51, reason: 'UNSAFE', db }))
      .rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code: 'ENTRY_EXPOSURE_UNRESOLVED' }) });
    expect(updateMany).not.toHaveBeenCalled();
    expect(calls).toEqual(['entry-exposure-lock']);
  });

  it.each([
    ['recorded structured not-sent evidence', 'ENTRY_SUBMITTING', [notSent(1)]],
    ['an adapter guard closing its boundary entry', 'ENTRY_SUBMITTING', [marker(1), notSent(2, 'NOT_SENT_LOCAL_BLOCKED')]],
    ['a claim that never reached ENTRY_SUBMITTING', 'ENTRY_PENDING', []],
  ] as const)('shared never-submitted release accepts %s and releases by compare-and-set under the lock', async (_label, status, events) => {
    const { db, calls } = releaseDb({ status }, [...events]);
    await releaseUnsubmittedEntryExposureClaim({ orderIntentId: 51, reason: 'PROVEN', db });
    expect(calls).toEqual(['entry-exposure-lock', 'compare-and-set']);
  });

  it('reports a compare-and-set miss as not released by this call', async () => {
    const { db } = releaseDb({ status: 'ENTRY_PENDING' }, [], { casCount: 0 });
    (db as unknown as { entryExposureClaim: { findUnique: ReturnType<typeof vi.fn> } }).entryExposureClaim.findUnique
      .mockResolvedValueOnce({ tradingAccountId: 7, securityId: 8 })
      .mockResolvedValueOnce({ id: 91, status: 'ENTRY_PENDING', releasedAt: null, trackedPositionId: null, orderIntent: { blockReason: null } })
      .mockResolvedValueOnce({ id: 91, status: 'RELEASED', releasedAt: new Date(), releaseReason: 'SOMEONE_ELSE' });
    const result = await releaseUnsubmittedEntryExposureClaim({ orderIntentId: 51, reason: 'MINE', db });
    expect(releasedByThisCall(result, 'MINE')).toBe(false);
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
