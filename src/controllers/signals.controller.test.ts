import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

const mocks = vi.hoisted(() => ({
  recordEntryDecision: vi.fn(),
  processSubscriptionEntrySignal: vi.fn(),
  processTargetedEntrySignal: vi.fn(),
}));

vi.mock('../services/entry-decision.service.js', () => ({
  recordEntryDecision: mocks.recordEntryDecision,
}));

vi.mock('../services/signal-entry.service.js', () => ({
  processSubscriptionEntrySignal: mocks.processSubscriptionEntrySignal,
  processTargetedEntrySignal: mocks.processTargetedEntrySignal,
}));

import {
  entryDecisionController,
  entrySignalController,
  assignmentEntrySignalController,
} from './signals.controller.js';

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };

  res.status.mockReturnValue(res);

  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe('signals controller entry decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 201 when a decision snapshot is persisted', async () => {
    mocks.recordEntryDecision.mockResolvedValue({
      persisted: true,
      skipped: false,
      duplicate: false,
      persistenceReason: 'initial_state',
      decision: {
        id: 101,
        decisionKey: 'decision-101',
      },
    });
    const res = response();
    const next = vi.fn() as NextFunction;
    const req = { body: { decisionKey: 'decision-101' } } as Request;

    await entryDecisionController(req, res, next);

    expect(mocks.recordEntryDecision).toHaveBeenCalledWith(req.body);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      decision: {
        persisted: true,
        skipped: false,
        duplicate: false,
        persistenceReason: 'initial_state',
        id: 101,
        decisionKey: 'decision-101',
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 200 for duplicate decision keys', async () => {
    mocks.recordEntryDecision.mockResolvedValue({
      persisted: false,
      skipped: false,
      duplicate: true,
      persistenceReason: 'duplicate_decision_key',
      decision: {
        id: 101,
        decisionKey: 'decision-101',
      },
    });
    const res = response();
    const next = vi.fn() as NextFunction;

    await entryDecisionController({ body: {} } as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      decision: expect.objectContaining({
        duplicate: true,
        id: 101,
        decisionKey: 'decision-101',
      }),
    });
  });

  it('returns 202 for intentionally skipped unchanged decisions', async () => {
    mocks.recordEntryDecision.mockResolvedValue({
      persisted: false,
      skipped: true,
      duplicate: false,
      persistenceReason: null,
      decision: null,
    });
    const res = response();
    const next = vi.fn() as NextFunction;

    await entryDecisionController({ body: {} } as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      decision: {
        persisted: false,
        skipped: true,
        duplicate: false,
        persistenceReason: null,
        id: null,
        decisionKey: null,
      },
    });
  });

  it('returns 400 for invalid decision payloads', async () => {
    mocks.recordEntryDecision.mockRejectedValue(
      new ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['decisionKey'],
          message: 'Invalid input: expected string',
        },
      ])
    );
    const res = response();
    const next = vi.fn() as NextFunction;

    await entryDecisionController({ body: {} } as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'ValidationError',
      message: 'Invalid entry decision payload.',
      details: expect.any(Array),
    });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('signals controller entry signals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a subscription key without an assignment ID', async () => {
    mocks.processSubscriptionEntrySignal.mockResolvedValue({
      subscriptionKey: 'spy_dip_core',
      results: [],
    });
    const res = response();
    const next = vi.fn() as NextFunction;

    await entrySignalController(
      {
        body: {
          subscriptionKey: 'spy_dip_core',
          decisionKey: 'decision-101',
          source: 'n8n-ai-trader',
        },
      } as Request,
      res,
      next
    );

    expect(mocks.processSubscriptionEntrySignal).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionKey: 'spy_dip_core' })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      signal: {
        subscriptionKey: 'spy_dip_core',
        signalType: 'entry',
        source: 'n8n-ai-trader',
        decisionKey: 'decision-101',
      },
      results: [],
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns a safe 400 for an invalid global subscription key', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await entrySignalController({ body: {} } as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'ValidationError',
      message: 'Invalid global entry signal payload.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([undefined, 'NaN', 0, -1, 1.5])(
    'returns 400 for targeted assignment id %s',
    async (tradingAccountSubscriptionId) => {
      const res = response();
      const next = vi.fn() as NextFunction;

      await assignmentEntrySignalController(
        { body: { tradingAccountSubscriptionId } } as Request,
        res,
        next
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mocks.processTargetedEntrySignal).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    }
  );

  it('routes one targeted assignment and confirms its subscription key', async () => {
    mocks.processTargetedEntrySignal.mockResolvedValue({
      tradingAccountId: 2,
      tradingAccountSubscriptionId: 38,
      accountDisplayName: 'Bobby Paper',
      environment: 'PAPER',
      subscriptionKey: 'intc_dip_core',
      outcome: 'INTENT_CREATED',
      code: 'INTENT_CREATED',
      message: 'Order intent created for the account assignment.',
      orderIntentId: 55,
    });
    const res = response();
    const next = vi.fn() as NextFunction;

    await assignmentEntrySignalController(
      {
        body: {
          tradingAccountSubscriptionId: 38,
          decisionKey: 'decision-101',
        },
      } as Request,
      res,
      next
    );

    expect(mocks.processTargetedEntrySignal).toHaveBeenCalledTimes(1);
    expect(mocks.processTargetedEntrySignal).toHaveBeenCalledWith(
      expect.objectContaining({ tradingAccountSubscriptionId: 38 })
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.objectContaining({
          tradingAccountSubscriptionId: 38,
          subscriptionKey: 'intc_dip_core',
        }),
        result: expect.not.objectContaining({
          credential: expect.anything(),
        }),
      })
    );
  });

  it('does not accept subscriptionKey as targeted routing identity', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await assignmentEntrySignalController(
      {
        body: {
          tradingAccountSubscriptionId: 38,
          subscriptionKey: 'intc_dip_core',
        },
      } as Request,
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.processTargetedEntrySignal).not.toHaveBeenCalled();
  });
});
