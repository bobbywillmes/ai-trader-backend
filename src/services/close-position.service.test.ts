import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  trackedPositionFindUnique: vi.fn(),
  trackedPositionUpdateMany: vi.fn(),
  orderIntentCreate: vi.fn(),
  orderIntentUpdateMany: vi.fn(),
  brokerOrderFindFirst: vi.fn(),
  brokerOrderCreate: vi.fn(),
  brokerOrderUpdate: vi.fn(),
  placeAlpacaOrder: vi.fn(),
  getAlpacaOrderByClientOrderId: vi.fn(),
  createSystemEvent: vi.fn(),
  forceAfterBrokerPositionWrite: vi.fn(),
  submitVerifiedExit: vi.fn(),
}));

const transactionClient = {
  trackedPosition: {
    findUnique: mocks.trackedPositionFindUnique,
    updateMany: mocks.trackedPositionUpdateMany,
  },
  orderIntent: {
    create: mocks.orderIntentCreate,
    updateMany: mocks.orderIntentUpdateMany,
  },
  brokerOrder: {
    findFirst: mocks.brokerOrderFindFirst,
    create: mocks.brokerOrderCreate,
    update: mocks.brokerOrderUpdate,
  },
};

vi.mock('../db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    orderIntent: {
      updateMany: mocks.orderIntentUpdateMany,
    },
  },
}));
vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  placeAlpacaOrder: mocks.placeAlpacaOrder,
  getAlpacaOrderByClientOrderId: mocks.getAlpacaOrderByClientOrderId,
}));
vi.mock('./verified-exit-submission.service.js', () => ({
  submitVerifiedExit: mocks.submitVerifiedExit,
}));
vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));
vi.mock('./adaptive-polling.service.js', () => ({
  adaptivePollingCoordinator: {
    forceAfterBrokerPositionWrite: mocks.forceAfterBrokerPositionWrite,
  },
}));

import { closeFailureSeverity, closePosition } from './close-position.service.js';
import { BrokerWriteDeliveryError } from '../errors/broker-write-delivery-error.js';
import { HttpError } from '../errors/http-error.js';

describe('close failure severity', () => {
  it('distinguishes protection, rejection, and delivery uncertainty', () => {
    expect(closeFailureSeverity({ classification: 'NOT_SENT_RETRYABLE', environment: 'LIVE', hasVerifiedProtection: true })).toBe('WARNING');
    expect(closeFailureSeverity({ classification: 'NOT_SENT_RETRYABLE', environment: 'LIVE', hasVerifiedProtection: false })).toBe('ERROR');
    expect(closeFailureSeverity({ classification: 'BROKER_REJECTED', environment: 'LIVE', hasVerifiedProtection: false })).toBe('ERROR');
    expect(closeFailureSeverity({ classification: 'DELIVERY_UNCERTAIN', environment: 'LIVE', hasVerifiedProtection: false })).toBe('CRITICAL');
    expect(closeFailureSeverity({ classification: 'DELIVERY_UNCERTAIN', environment: 'PAPER', hasVerifiedProtection: false })).toBe('ERROR');
  });
});

function position(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    symbol: 'AAPL',
    side: 'long',
    qty: 2,
    status: 'open',
    securityId: 11,
    subscriptionId: 21,
    tradingAccountId: 31,
    tradingAccount: { environment: 'PAPER' },
    tradingAccountSubscriptionId: 41,
    orderIntents: [],
    brokerOrders: [],
    tradingAccountSubscription: {
      id: 41,
      tradingAccountId: 31,
      subscriptionId: 21,
      enabled: true,
      exitsEnabled: true,
    },
    ...overrides,
  };
}

describe('closePosition claim-before-write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient)
    );
    mocks.trackedPositionFindUnique.mockResolvedValue(position());
    mocks.trackedPositionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.orderIntentCreate.mockResolvedValue({ id: 501 });
    mocks.orderIntentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.brokerOrderFindFirst.mockResolvedValue(null);
    mocks.brokerOrderCreate.mockResolvedValue({ id: 601 });
    mocks.createSystemEvent.mockResolvedValue(undefined);
    mocks.placeAlpacaOrder.mockResolvedValue({
      id: 'broker-close-1',
      client_order_id: 'ai-exit-close-31-101',
      symbol: 'AAPL',
      side: 'sell',
      status: 'accepted',
    });
    mocks.submitVerifiedExit.mockImplementation(async () => {
      try {
        return { outcome: 'SUBMITTED', order: await mocks.placeAlpacaOrder() };
      } catch (error) {
        if (error instanceof BrokerWriteDeliveryError && error.classification === 'BROKER_REJECTED') {
          const recovered = await mocks.getAlpacaOrderByClientOrderId(31, 'ai-exit-close-31-101', 'pending_order_idempotency_check');
          if (recovered) return { outcome: 'RECOVERED_BROKER', order: recovered };
        }
        throw error;
      }
    });
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(null);
  });

  it('durably claims the exact account before submitting a deterministic close', async () => {
    await expect(closePosition(101)).resolves.toMatchObject({
      ok: true,
      trackedPositionId: 101,
      tradingAccountId: 31,
      clientOrderId: 'ai-exit-close-31-101',
    });

    expect(mocks.trackedPositionUpdateMany).toHaveBeenCalledWith({
      where: { id: 101, status: 'open' },
      data: { status: 'closing', lastSyncedAt: expect.any(Date) },
    });
    expect(mocks.orderIntentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'submitting',
        clientOrderId: 'ai-exit-close-31-101',
        tradingAccountId: 31,
        tradingAccountSubscriptionId: 41,
        trackedPositionId: 101,
      }),
    });
    expect(mocks.submitVerifiedExit).toHaveBeenCalledWith(expect.objectContaining({
      tradingAccountId: 31,
      trackedPositionId: 101,
      intendedQty: 2,
      clientOrderId: 'ai-exit-close-31-101',
      order: { type: 'market', timeInForce: 'day' },
    }));
    expect(
      mocks.trackedPositionUpdateMany.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.placeAlpacaOrder.mock.invocationCallOrder[0]!);
  });

  it('lets a manual emergency close bypass assignment automated-exit controls', async () => {
    mocks.trackedPositionFindUnique.mockResolvedValue(
      position({
        tradingAccountSubscription: {
          ...position().tradingAccountSubscription,
          enabled: false,
          exitsEnabled: false,
        },
      })
    );

    await expect(
      closePosition(101, { mode: 'MANUAL_EMERGENCY_CLOSE' })
    ).resolves.toMatchObject({ ok: true });
    expect(mocks.placeAlpacaOrder).toHaveBeenCalledOnce();
  });

  it('blocks an automated strategy close when assignment exits are disabled', async () => {
    mocks.trackedPositionFindUnique.mockResolvedValue(
      position({
        tradingAccountSubscription: {
          ...position().tradingAccountSubscription,
          exitsEnabled: false,
        },
      })
    );

    await expect(closePosition(101)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.placeAlpacaOrder).not.toHaveBeenCalled();
  });

  it('returns a conflict for an existing close claim or order', async () => {
    mocks.trackedPositionFindUnique.mockResolvedValue(
      position({
        orderIntents: [
          {
            id: 500,
            status: 'submitting',
            clientOrderId: 'ai-exit-close-31-101',
          },
        ],
      })
    );

    await expect(closePosition(101)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('already pending'),
    });
    expect(mocks.placeAlpacaOrder).not.toHaveBeenCalled();
  });

  it('fails closed for unattributed or inconsistent positions', async () => {
    mocks.trackedPositionFindUnique
      .mockResolvedValueOnce(position({ tradingAccountId: null }))
      .mockResolvedValueOnce(
        position({
          tradingAccountSubscription: {
            ...position().tradingAccountSubscription,
            tradingAccountId: 99,
          },
        })
      );

    await expect(closePosition(101)).rejects.toMatchObject({ statusCode: 409 });
    await expect(closePosition(101)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.placeAlpacaOrder).not.toHaveBeenCalled();
  });

  it('retains a submitting claim for deterministic recovery on broker failure', async () => {
    mocks.placeAlpacaOrder.mockRejectedValue(new Error('network uncertain'));

    await expect(closePosition(101)).rejects.toThrow('network uncertain');

    expect(mocks.orderIntentUpdateMany).toHaveBeenCalledWith({
      where: { id: 501, status: 'submitting' },
      data: {
        blockReason: expect.stringContaining('DELIVERY_UNCERTAIN'),
      },
    });
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'position.close_submission_uncertain',
        tradingAccountId: 31,
        severity: 'ERROR',
      })
    );
  });

  it('releases a pre-submit verification block without recording delivery uncertainty', async () => {
    mocks.submitVerifiedExit.mockRejectedValue(new HttpError(409, 'existing sell reserves shares', {
      verificationOutcome: 'CONFLICTING_OPEN_SELL_ORDER',
      authorizationResult: 'NOT_ATTEMPTED',
    }));

    await expect(closePosition(101)).rejects.toMatchObject({ statusCode: 409 });

    expect(mocks.placeAlpacaOrder).not.toHaveBeenCalled();
    expect(mocks.orderIntentUpdateMany).toHaveBeenCalledWith({
      where: { id: 501, status: { in: ['pending', 'submitting'] } },
      data: {
        status: 'blocked',
        blockReason: 'EXIT_VERIFICATION:CONFLICTING_OPEN_SELL_ORDER',
      },
    });
    expect(mocks.trackedPositionUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 101, status: 'closing' },
      data: { status: 'open', lastSyncedAt: expect.any(Date) },
    });
    expect(mocks.createSystemEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'position.close_submission_uncertain',
    }));
  });

  it.each([
    ['NOT_SENT_RETRYABLE', 'failed'],
    ['NOT_SENT_BLOCKED', 'blocked'],
  ] as const)(
    'releases the close claim when delivery is %s',
    async (classification, expectedStatus) => {
      mocks.placeAlpacaOrder.mockRejectedValue(
        new BrokerWriteDeliveryError({
          classification,
          message: 'safe local blocker',
        })
      );

      await expect(closePosition(101)).rejects.toThrow('safe local blocker');

      expect(mocks.orderIntentUpdateMany).toHaveBeenCalledWith({
        where: { id: 501, status: 'submitting' },
        data: {
          status: expectedStatus,
          blockReason: expect.stringContaining(classification),
        },
      });
      expect(mocks.trackedPositionUpdateMany).toHaveBeenLastCalledWith({
        where: { id: 101, status: 'closing' },
        data: { status: 'open', lastSyncedAt: expect.any(Date) },
      });
      expect(mocks.createSystemEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'position.close_not_sent', severity: 'ERROR' })
      );
    }
  );

  it('confirms broker rejection absence before releasing the claim', async () => {
    mocks.placeAlpacaOrder.mockRejectedValue(
      new BrokerWriteDeliveryError({
        classification: 'BROKER_REJECTED',
        message: 'Alpaca rejected write',
        statusCode: 422,
      })
    );
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(null);

    await expect(closePosition(101)).rejects.toThrow('Alpaca rejected write');

    expect(mocks.getAlpacaOrderByClientOrderId).toHaveBeenCalledWith(
      31,
      'ai-exit-close-31-101',
      'pending_order_idempotency_check'
    );
    expect(mocks.trackedPositionUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'open' }) })
    );
  });

  it('materializes an accepted order discovered after an explicit rejection response', async () => {
    mocks.placeAlpacaOrder.mockRejectedValue(
      new BrokerWriteDeliveryError({
        classification: 'BROKER_REJECTED',
        message: 'ambiguous client response',
        statusCode: 422,
      })
    );
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue({
      id: 'broker-close-recovered',
      client_order_id: 'ai-exit-close-31-101',
      symbol: 'AAPL',
      side: 'sell',
      status: 'accepted',
    });

    await expect(closePosition(101)).resolves.toMatchObject({
      brokerOrderId: 'broker-close-recovered',
    });
    expect(mocks.brokerOrderCreate).toHaveBeenCalledOnce();
  });

  it('allows at most one broker write across concurrent close attempts', async () => {
    let claimed = false;
    mocks.trackedPositionFindUnique.mockImplementation(async () =>
      position({ status: claimed ? 'closing' : 'open' })
    );
    mocks.trackedPositionUpdateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });

    const results = await Promise.allSettled([
      closePosition(101),
      closePosition(101),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(mocks.placeAlpacaOrder).toHaveBeenCalledOnce();
  });
});
