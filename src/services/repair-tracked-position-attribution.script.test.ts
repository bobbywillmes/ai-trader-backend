import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROKER_CLIENT_ORDER_RESOLUTION_EVIDENCE,
  repairTrackedPositionAttribution,
  type RepairArgs,
} from './tracked-position-attribution-repair.service.js';

const clientOrderId =
  'ai-20260707T164126-DIA-buy-market-skx6469615f6469705f636f7265-4860eb93';
const updatedAt = new Date('2026-07-07T16:42:00.000Z');

const args: RepairArgs = {
  positionId: 51,
  expectedAccountId: 1,
  expectedCurrentSubscriptionId: 13,
  expectedCurrentAssignmentId: null,
  expectedSubscriptionId: 13,
  expectedSubscriptionKey: 'dia_dip_core',
  expectedAssignmentId: 24,
  apply: false,
};

function activity(id: number, qty: number, price: number) {
  return {
    id,
    tradingAccountId: 1,
    activityType: 'FILL',
    symbol: 'DIA',
    side: 'buy',
    qty,
    price,
    brokerOrderRecordId: 61,
    brokerOrderRecord: {
      id: 61,
      tradingAccountId: 1,
      symbol: 'DIA',
      side: 'buy',
      clientOrderId,
    },
  };
}

function position() {
  return {
    id: 51,
    symbol: 'DIA',
    qty: 4,
    avgEntryPrice: 528.4025,
    status: 'open',
    tradingAccountId: 1,
    subscriptionId: 13,
    tradingAccountSubscriptionId: null,
    updatedAt,
    configSnapshotJson: null,
    orderIntents: [],
    entryDecision: null,
    brokerOrders: [],
    brokerActivities: [
      activity(119, 2, 528.4),
      activity(120, 1, 528.4),
      activity(121, 1, 528.41),
      {
        ...activity(108, 4, 527),
        side: 'sell',
        brokerOrderRecordId: 55,
        brokerOrderRecord: {
          id: 55,
          tradingAccountId: 1,
          symbol: 'DIA',
          side: 'sell',
          clientOrderId: 'separate-close-lifecycle',
        },
      },
    ],
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 376,
    type: 'position.subscription_resolved',
    tradingAccountId: 1,
    payloadJson: {
      source: 'broker_client_order_id',
      subscriptionId: 13,
      subscriptionKey: 'dia_dip_core',
      evidence: { clientOrderIds: [clientOrderId] },
    },
    ...overrides,
  };
}

function openedEvent() {
  return {
    id: 377,
    type: 'position.opened',
    tradingAccountId: 1,
    payloadJson: {
      symbol: 'DIA',
      qty: 4,
      avgEntryPrice: 528.4025,
      subscriptionId: 13,
      subscriptionResolutionSource: 'broker_client_order_id',
      subscriptionResolutionStatus: 'resolved',
    },
  };
}

function database() {
  const db = {
    trackedPosition: {
      findUnique: vi.fn().mockResolvedValue(position()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    tradingAccountSubscription: {
      findMany: vi.fn().mockResolvedValue([{
        id: 24,
        tradingAccountId: 1,
        subscriptionId: 13,
        subscription: { key: 'dia_dip_core' },
      }]),
    },
    systemEvent: {
      findMany: vi.fn().mockResolvedValue([event(), openedEvent()]),
    },
    $transaction: vi.fn(async (callback) => callback(db)),
  };
  return db;
}

describe('tracked-position broker-client-order attribution repair', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('accepts the exact account-scoped three-partial-fill evidence pattern', async () => {
    const result = await repairTrackedPositionAttribution(args, database() as never);

    expect(result).toMatchObject({
      mode: 'dry-run',
      evidenceSummary: {
        evidenceClass: BROKER_CLIENT_ORDER_RESOLUTION_EVIDENCE,
        systemEventIds: [376],
        positionOpenedEventIds: [377],
        clientOrderId,
        brokerOrderRecordId: 61,
        brokerActivityIds: [119, 120, 121],
        fillQty: 4,
      },
      proposed: { tradingAccountSubscriptionId: 24 },
    });
    expect(result.evidenceSummary).toMatchObject({
      weightedAveragePrice: expect.closeTo(528.4025, 8),
    });
  });

  it('rejects a client-order subscription token mismatch', async () => {
    const db = database();
    db.systemEvent.findMany.mockResolvedValue([
      event({
        payloadJson: {
          source: 'broker_client_order_id',
          subscriptionId: 13,
          subscriptionKey: 'dia_dip_core',
          evidence: {
            clientOrderIds: [
              'ai-20260707T164126-DIA-buy-market-skx6469615f616c74-4860eb93',
            ],
          },
        },
      }),
      openedEvent(),
    ]);

    await expect(repairTrackedPositionAttribution(args, db as never))
      .rejects.toThrow('Contradictory position subscription-resolution event');
  });

  it('rejects opening activity owned by the wrong account', async () => {
    const db = database();
    const value = position();
    value.brokerActivities[0]!.tradingAccountId = 2;
    db.trackedPosition.findUnique.mockResolvedValue(value);

    await expect(repairTrackedPositionAttribution(args, db as never))
      .rejects.toThrow('Contradictory linked opening activity');
  });

  it('rejects resolution evidence for the wrong subscription', async () => {
    const db = database();
    db.systemEvent.findMany.mockResolvedValue([
      event({
        payloadJson: {
          source: 'broker_client_order_id',
          subscriptionId: 99,
          subscriptionKey: 'dia_dip_core',
          evidence: { clientOrderIds: [clientOrderId] },
        },
      }),
      openedEvent(),
    ]);

    await expect(repairTrackedPositionAttribution(args, db as never))
      .rejects.toThrow('Contradictory position subscription-resolution event');
  });

  it('rejects a partial-fill quantity mismatch', async () => {
    const db = database();
    const value = position();
    value.brokerActivities = value.brokerActivities.filter(({ id }) => id !== 121);
    db.trackedPosition.findUnique.mockResolvedValue(value);

    await expect(repairTrackedPositionAttribution(args, db as never))
      .rejects.toThrow('Opening fill quantity does not match');
  });

  it('rejects a weighted-average opening price mismatch', async () => {
    const db = database();
    const value = position();
    value.brokerActivities[2]!.price = 529;
    db.trackedPosition.findUnique.mockResolvedValue(value);

    await expect(repairTrackedPositionAttribution(args, db as never))
      .rejects.toThrow('weighted-average price does not match');
  });

  it('rejects contradictory resolution event evidence', async () => {
    const db = database();
    db.systemEvent.findMany.mockResolvedValue([
      event(),
      openedEvent(),
      event({
        id: 378,
        payloadJson: {
          source: 'broker_client_order_id',
          subscriptionId: 14,
          subscriptionKey: 'dia_alt',
          evidence: {
            clientOrderIds: [
              'ai-20260707T164126-DIA-buy-market-skx6469615f616c74-12345678',
            ],
          },
        },
      }),
    ]);

    await expect(repairTrackedPositionAttribution(args, db as never))
      .rejects.toThrow('Contradictory position subscription-resolution event');
  });

  it('rejects an ambiguous account assignment', async () => {
    const db = database();
    db.tradingAccountSubscription.findMany.mockResolvedValue([
      {
        id: 24,
        tradingAccountId: 1,
        subscriptionId: 13,
        subscription: { key: 'dia_dip_core' },
      },
      {
        id: 25,
        tradingAccountId: 1,
        subscriptionId: 13,
        subscription: { key: 'dia_dip_core' },
      },
    ]);

    await expect(repairTrackedPositionAttribution(args, db as never))
      .rejects.toThrow('exactly one matching reviewed account assignment');
  });

  it('rejects a concurrent row change during apply', async () => {
    const db = database();
    db.trackedPosition.updateMany.mockResolvedValue({ count: 0 });

    await expect(repairTrackedPositionAttribution(
      { ...args, apply: true },
      db as never
    )).rejects.toThrow('row changed after review');
  });

  it('ignores an unrelated sell fill from a separate lifecycle', async () => {
    const result = await repairTrackedPositionAttribution(args, database() as never);

    expect(result.evidenceSummary).toMatchObject({
      evidenceClass: BROKER_CLIENT_ORDER_RESOLUTION_EVIDENCE,
      brokerActivityIds: [119, 120, 121],
    });
    expect(result.evidenceSummary).not.toMatchObject({
      brokerActivityIds: expect.arrayContaining([108]),
    });
  });
});
