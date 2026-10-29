import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ submitOrder: vi.fn() }));
vi.mock('./place-order.service.js', () => ({ submitOrder: mocks.submitOrder }));

import { processProspectiveTradingViewEntries } from './external-signal-entry-admission.service.js';

function candidate(id: number, createdAt = new Date('2026-10-29T12:00:00Z')) {
  return {
    id, externalSignalTradeCycleId: id + 100, entrySignalRouteId: id + 200,
    tradingAccountId: id + 300, tradingAccountSubscriptionId: id + 400,
    subscriptionId: id + 500, securityId: id + 600, entryRolloutGenerationId: 7,
    createdAt, tradeCycle: {}, entryRoute: { routingRun: { signal: {
      id: id + 700, createdAt, strategySignalRevisionId: 8, strategyRevision: 1,
      signalSourceId: 9, strategySignalBindingId: 10,
    } } },
  };
}

function database(rows: ReturnType<typeof candidate>[]) {
  const tx = {
    externalSignalTradeCycleAccount: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    systemEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    tx,
    db: {
      externalSignalTradeCycleAccount: {
        findMany: vi.fn().mockResolvedValue(rows),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      externalSignalEntryExecutionAuthorization: { findFirst: vi.fn().mockResolvedValue({ id: 11, rolloutGenerationId: 7 }) },
      systemEvent: { create: vi.fn().mockResolvedValue({}) },
      operationalAttention: { upsert: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    },
  };
}

describe('TradingView prospective entry coordinator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('permanently refuses stale immutable evidence and still admits the next candidate', async () => {
    const fixture = database([
      candidate(1, new Date('2026-10-29T11:57:59Z')),
      candidate(2, new Date('2026-10-29T11:59:30Z')),
    ]);
    mocks.submitOrder.mockResolvedValue({ ok: true, intentId: 1, status: 'pending' });
    const result = await processProspectiveTradingViewEntries({
      db: fixture.db as never, now: new Date('2026-10-29T12:00:00Z'), maxAgeMs: 120_000,
    });
    expect(result).toMatchObject({ examined: 2, admitted: 1, refused: 1, retryable: 0 });
    expect(fixture.tx.externalSignalTradeCycleAccount.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: 'ENTRY_EXECUTION_PROSPECTIVE' }, data: { status: 'BLOCKED' },
    });
    expect(mocks.submitOrder).toHaveBeenCalledTimes(1);
  });

  it('isolates a technical failure and continues the coordinator batch', async () => {
    const fixture = database([candidate(1), candidate(2)]);
    mocks.submitOrder.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce({ ok: true });
    const result = await processProspectiveTradingViewEntries({
      db: fixture.db as never, now: new Date('2026-10-29T12:00:30Z'), maxAgeMs: 120_000,
    });
    expect(result).toMatchObject({ examined: 2, admitted: 1, refused: 0, retryable: 1 });
    expect(mocks.submitOrder).toHaveBeenCalledTimes(2);
    expect(fixture.tx.externalSignalTradeCycleAccount.updateMany).not.toHaveBeenCalled();
  });
});
