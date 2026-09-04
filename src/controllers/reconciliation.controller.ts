import type { NextFunction, Request, Response } from 'express';

import {
  reconcileTradingAccountWithLock,
  ReconciliationBrokerUnavailableError,
  runReconciliationCheck,
} from '../services/reconciliation.service.js';
import { HttpError } from '../errors/http-error.js';

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
    if (error instanceof ReconciliationBrokerUnavailableError) {
      next(new HttpError(503, error.message, {
        code: 'RECONCILIATION_UNAVAILABLE',
        tradingAccountId: error.tradingAccountId,
      }));
      return;
    }
    next(error);
  }
}

export async function runTradingAccountReconciliationController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const tradingAccountId = Number(req.params.id);
    if (!Number.isInteger(tradingAccountId) || tradingAccountId <= 0) {
      throw new HttpError(400, 'Invalid trading account id.');
    }
    const persistEvents = shouldPersistEvents(req);
    const result = await reconcileTradingAccountWithLock(tradingAccountId, {
      persistEvents,
      persistAttention: shouldPersistAttention(req, persistEvents),
      dedupeEvents: shouldDedupeEvents(req),
    });
    res.status(200).json({ ok: true, dryRun: !persistEvents, ...result });
  } catch (error) {
    if (error instanceof ReconciliationBrokerUnavailableError) {
      next(new HttpError(503, error.message, {
        code: 'RECONCILIATION_UNAVAILABLE',
        tradingAccountId: error.tradingAccountId,
      }));
      return;
    }
    next(error);
  }
}
