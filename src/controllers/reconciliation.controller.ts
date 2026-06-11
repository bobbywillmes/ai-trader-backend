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