import type { NextFunction, Request, Response } from 'express';

import { runReconciliationCheck } from '../services/reconciliation.service.js';

function shouldPersistEvents(req: Request) {
  return req.body?.persistEvents === true || req.query.persistEvents === 'true';
}

export async function runReconciliationController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const persistEvents = shouldPersistEvents(req);
    const result = await runReconciliationCheck({ persistEvents });

    res.status(200).json({
      ok: true,
      dryRun: !persistEvents,
      ...result,
    });
  } catch (error) {
    next(error);
  }
}