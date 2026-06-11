import type { NextFunction, Request, Response } from 'express';

import { runReconciliationCheck } from '../services/reconciliation.service.js';

function shouldPersistEvents(req: Request) {
  return req.body?.persistEvents === true || req.query.persistEvents === 'true';
}

function shouldPersistAttention(req: Request, persistEvents: boolean) {
  if (req.body?.persistAttention === true || req.query.persistAttention === 'true') {
    return true;
  }

  if (req.body?.persistAttention === false || req.query.persistAttention === 'false') {
    return false;
  }

  return persistEvents;
}

function shouldDedupeEvents(req: Request) {
  if (req.body?.dedupeEvents === false || req.query.dedupeEvents === 'false') {
    return false;
  }

  return true;
}

export async function runReconciliationController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const persistEvents = shouldPersistEvents(req);
    const persistAttention = shouldPersistAttention(req, persistEvents);

    const result = await runReconciliationCheck({
      persistEvents,
      persistAttention,
      dedupeEvents: shouldDedupeEvents(req),
    });

    res.status(200).json({
      ok: true,
      dryRun: !persistEvents,
      ...result,
    });
  } catch (error) {
    next(error);
  }
}