import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../errors/http-error.js';

const mocks = vi.hoisted(() => ({
  subscriptionFindUnique: vi.fn(),
  assignmentFindUnique: vi.fn(),
  intentFindFirst: vi.fn(),
  submitOrder: vi.fn(),
  createSystemEvent: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    subscription: { findUnique: mocks.subscriptionFindUnique },
    tradingAccountSubscription: { findUnique: mocks.assignmentFindUnique },
    orderIntent: { findFirst: mocks.intentFindFirst },
  },
}));
vi.mock('./place-order.service.js', () => ({
  submitOrder: mocks.submitOrder,
}));
vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

import {
  processEntryForAccountSubscription,
  processSubscriptionEntrySignal,
  processTargetedEntrySignal,
} from './signal-entry.service.js';

function assignment(id: number, name: string, environment: 'PAPER' | 'LIVE') {
  return {
    id,
    subscription: { key: 'intc_dip_core' },
    tradingAccount: {
      id: id + 100,
      displayName: name,
      environment,
    },
  };
}

describe('signal entry routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.intentFindFirst.mockResolvedValue(null);
    mocks.createSystemEvent.mockResolvedValue({});
  });

  it('fans out independently when one deployment is blocked', async () => {
    mocks.subscriptionFindUnique.mockResolvedValue({
      key: 'intc_dip_core',
      accountSubscriptions: [
        { id: 38, tradingAccount: assignment(38, 'Bobby Paper', 'PAPER').tradingAccount },
        { id: 39, tradingAccount: assignment(39, 'Bobby Live', 'LIVE').tradingAccount },
      ],
    });
    mocks.assignmentFindUnique
      .mockResolvedValueOnce(assignment(38, 'Bobby Paper', 'PAPER'))
      .mockResolvedValueOnce(assignment(39, 'Bobby Live', 'LIVE'));
    mocks.submitOrder
      .mockResolvedValueOnce({ intentId: 501 })
      .mockRejectedValueOnce(
        new HttpError(403, 'Trading is disabled for account 139.')
      );

    const result = await processSubscriptionEntrySignal({
      subscriptionKey: 'intc_dip_core',
      signalType: 'entry',
      source: 'n8n-ai-trader',
      decisionKey: 'global-decision-1',
    });

    expect(mocks.submitOrder).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([
      expect.objectContaining({
        tradingAccountSubscriptionId: 38,
        accountDisplayName: 'Bobby Paper',
        outcome: 'INTENT_CREATED',
        orderIntentId: 501,
      }),
      expect.objectContaining({
        tradingAccountSubscriptionId: 39,
        accountDisplayName: 'Bobby Live',
        outcome: 'BLOCKED',
        code: 'ACCOUNT_TRADING_DISABLED',
      }),
    ]);
  });

  it('scopes duplicate detection by signal identity and assignment', async () => {
    mocks.assignmentFindUnique
      .mockResolvedValueOnce(assignment(38, 'Bobby Paper', 'PAPER'))
      .mockResolvedValueOnce(assignment(39, 'Second Paper', 'PAPER'));
    mocks.intentFindFirst
      .mockResolvedValueOnce({ id: 501 })
      .mockResolvedValueOnce(null);
    mocks.submitOrder.mockResolvedValueOnce({ intentId: 502 });
    const signal = {
      signalType: 'entry' as const,
      source: 'n8n-ai-trader',
      decisionKey: 'global-decision-1',
    };

    const first = await processEntryForAccountSubscription({
      tradingAccountSubscriptionId: 38,
      signal,
      source: signal.source,
    });
    const second = await processEntryForAccountSubscription({
      tradingAccountSubscriptionId: 39,
      signal,
      source: signal.source,
    });

    expect(first).toEqual(
      expect.objectContaining({
        outcome: 'DUPLICATE',
        orderIntentId: 501,
      })
    );
    expect(second).toEqual(
      expect.objectContaining({
        outcome: 'INTENT_CREATED',
        orderIntentId: 502,
      })
    );
    expect(mocks.submitOrder).toHaveBeenCalledTimes(1);
    const submittedOptions = mocks.submitOrder.mock.calls[0]?.[1];
    expect(submittedOptions.clientOrderId).toContain('tas39-');
  });

  it('targeted processing resolves exactly assignment 38 and never fans out', async () => {
    mocks.assignmentFindUnique.mockResolvedValue(
      assignment(38, 'Bobby Paper', 'PAPER')
    );
    mocks.submitOrder.mockResolvedValue({ intentId: 501 });

    const result = await processTargetedEntrySignal({
      tradingAccountSubscriptionId: 38,
      signalType: 'entry',
      source: 'n8n-smoke-test',
      decisionKey: 'smoke-1',
    });

    expect(mocks.assignmentFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.assignmentFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 38 } })
    );
    expect(mocks.subscriptionFindUnique).not.toHaveBeenCalled();
    expect(mocks.submitOrder).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        tradingAccountSubscriptionId: 38,
        accountDisplayName: 'Bobby Paper',
        environment: 'PAPER',
      })
    );
  });

  it('returns 404 for an unknown targeted assignment', async () => {
    mocks.assignmentFindUnique.mockResolvedValue(null);

    await expect(
      processTargetedEntrySignal({
        tradingAccountSubscriptionId: 999,
        signalType: 'entry',
        source: 'n8n-smoke-test',
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.submitOrder).not.toHaveBeenCalled();
  });
});
