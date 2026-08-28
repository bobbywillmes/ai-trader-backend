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
  signalEntryOutcomeSeverity,
} from './signal-entry.service.js';

it('maps structured signal outcomes to intentional severity', () => {
  expect(signalEntryOutcomeSeverity('INTENT_CREATED')).toBe('INFO');
  expect(signalEntryOutcomeSeverity('DUPLICATE')).toBe('INFO');
  expect(signalEntryOutcomeSeverity('BLOCKED')).toBe('WARNING');
  expect(signalEntryOutcomeSeverity('FAILED')).toBe('ERROR');
});

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

  it('returns and audits the stable LIVE policy code without an intent', async () => {
    mocks.assignmentFindUnique.mockResolvedValue(
      assignment(39, 'Bobby Live', 'LIVE')
    );
    mocks.intentFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mocks.submitOrder.mockRejectedValue(
      new HttpError(403, 'LIVE entry writes are blocked.', {
        code: 'live_entry_policy_blocked',
        rule: 'live_entry_policy_blocked',
      })
    );

    const result = await processEntryForAccountSubscription({
      tradingAccountSubscriptionId: 39,
      signal: {
        signalType: 'entry',
        source: 'n8n-smoke-test',
        decisionKey: 'live-policy-test',
      },
      source: 'n8n-smoke-test',
    });

    expect(result).toEqual(
      expect.objectContaining({
        tradingAccountId: 139,
        tradingAccountSubscriptionId: 39,
        environment: 'LIVE',
        outcome: 'BLOCKED',
        code: 'LIVE_ENTRY_POLICY_BLOCKED',
        orderIntentId: null,
      })
    );
    expect(mocks.assignmentFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.assignmentFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 39 } })
    );
    expect(mocks.intentFindFirst).toHaveBeenCalledTimes(2);
    expect(mocks.intentFindFirst).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        tradingAccountSubscriptionId: 39,
      }),
      select: { id: true },
    });
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 39,
        tradingAccountId: 139,
        payloadJson: expect.objectContaining({
          tradingAccountSubscriptionId: 39,
          outcome: 'BLOCKED',
          code: 'LIVE_ENTRY_POLICY_BLOCKED',
          orderIntentId: null,
        }),
      })
    );
  });

  it('continues subscription fan-out after a LIVE policy block', async () => {
    mocks.subscriptionFindUnique.mockResolvedValue({
      key: 'intc_dip_core',
      accountSubscriptions: [
        {
          id: 39,
          tradingAccount: assignment(39, 'Bobby Live', 'LIVE').tradingAccount,
        },
        {
          id: 40,
          tradingAccount: assignment(40, 'Second Paper', 'PAPER').tradingAccount,
        },
      ],
    });
    mocks.assignmentFindUnique
      .mockResolvedValueOnce(assignment(39, 'Bobby Live', 'LIVE'))
      .mockResolvedValueOnce(assignment(40, 'Second Paper', 'PAPER'));
    mocks.intentFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mocks.submitOrder
      .mockRejectedValueOnce(
        new HttpError(403, 'LIVE entry writes are blocked.', {
          code: 'live_entry_policy_blocked',
        })
      )
      .mockResolvedValueOnce({ intentId: 502 });

    const result = await processSubscriptionEntrySignal({
      subscriptionKey: 'intc_dip_core',
      signalType: 'entry',
      source: 'n8n-ai-trader',
      decisionKey: 'fanout-live-policy-test',
    });

    expect(mocks.submitOrder).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([
      expect.objectContaining({
        tradingAccountSubscriptionId: 39,
        outcome: 'BLOCKED',
        code: 'LIVE_ENTRY_POLICY_BLOCKED',
        orderIntentId: null,
      }),
      expect.objectContaining({
        tradingAccountSubscriptionId: 40,
        outcome: 'INTENT_CREATED',
        orderIntentId: 502,
      }),
    ]);
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
