import type { Request, Response, NextFunction } from 'express';
import { entrySignalSchema } from '../validators/signal.schema.js';
import { submitOrder } from '../services/place-order.service.js';

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