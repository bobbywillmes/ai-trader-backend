import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { entrySignalSchema } from '../validators/signal.schema.js';
import { submitOrder } from '../services/place-order.service.js';
import { recordEntryDecision } from '../services/entry-decision.service.js';

function toEntryDecisionResponse(
  result: Awaited<ReturnType<typeof recordEntryDecision>>
) {
  return {
    ok: true,
    decision: {
      persisted: result.persisted,
      skipped: result.skipped,
      duplicate: result.duplicate,
      persistenceReason: result.persistenceReason,
      id: result.decision?.id ?? null,
      decisionKey: result.decision?.decisionKey ?? null,
    },
  };
}

function entryDecisionStatus(
  result: Awaited<ReturnType<typeof recordEntryDecision>>
) {
  if (result.persisted) return 201;
  if (result.skipped) return 202;

  return 200;
}

export async function entrySignalController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const signal = entrySignalSchema.parse(req.body);
    console.log('Received entry signal:', signal);

    const result = await submitOrder({
      subscriptionKey: signal.subscriptionKey,
      signalType: 'entry',
      orderType: 'market',
      timeInForce: 'day',
      extendedHours: false,
      signalMetadata: {
        source: signal.source,
        reason: signal.reason ?? null,
        score: signal.score ?? null,
        confidence: signal.confidence ?? null,
        runId: signal.runId ?? null,
        batchId: signal.batchId ?? null,
        metadata: signal.metadata ?? null,
      },
    });

    res.status(201).json({
      ok: true,
      signal: {
        subscriptionKey: signal.subscriptionKey,
        signalType: signal.signalType,
        source: signal.source,
      },
      order: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function entryDecisionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await recordEntryDecision(req.body);

    res.status(entryDecisionStatus(result)).json(toEntryDecisionResponse(result));
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid entry decision payload.',
        details: error.issues,
      });
      return;
    }

    next(error);
  }
}
