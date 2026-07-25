import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import {
  assignmentEntrySignalSchema,
  entrySignalSchema,
} from '../validators/signal.schema.js';
import { recordEntryDecision } from '../services/entry-decision.service.js';
import {
  processSubscriptionEntrySignal,
  processTargetedEntrySignal,
} from '../services/signal-entry.service.js';

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
    const result = await processSubscriptionEntrySignal(signal);
    res.status(200).json({
      ok: true,
      signal: {
        subscriptionKey: signal.subscriptionKey,
        signalType: signal.signalType,
        source: signal.source,
        decisionKey: signal.decisionKey ?? null,
      },
      results: result.results,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid global entry signal payload.',
      });
      return;
    }
    next(error);
  }
}

export async function assignmentEntrySignalController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const signal = assignmentEntrySignalSchema.parse(req.body);
    const result = await processTargetedEntrySignal(signal);
    res.status(result.outcome === 'INTENT_CREATED' ? 201 : 200).json({
      ok: true,
      signal: {
        tradingAccountSubscriptionId:
          signal.tradingAccountSubscriptionId,
        subscriptionKey: result.subscriptionKey,
        signalType: signal.signalType,
        source: signal.source,
        decisionKey: signal.decisionKey ?? null,
      },
      result,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid targeted entry signal payload.',
      });
      return;
    }
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
