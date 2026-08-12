import type { Request, Response, NextFunction } from 'express';
import { getAccessibleSystemEvents } from '../services/system-event.service.js';
import { getSecurityActivity } from '../services/system-event.service.js';
import { HttpError } from '../errors/http-error.js';

export async function systemEventsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!res.locals.user) throw new HttpError(401, 'Authentication required.');
    const account = req.query.account === 'all' ? null : Number(req.query.account);
    if (account !== null && (!Number.isInteger(account) || account <= 0)) {
      throw new HttpError(400, 'A valid account query parameter is required.');
    }
    const page = getQueryNumber(req.query.page, 1);
    const pageSize = getQueryNumber(req.query.pageSize, 25);
    const type = typeof req.query.type === 'string' && req.query.type !== 'all' ? req.query.type : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const events = await getAccessibleSystemEvents(res.locals.user, account, {
      page,
      pageSize,
      ...(type ? { type } : {}),
      ...(search ? { search } : {}),
    });

    res.status(200).json(events);
  } catch (error) {
    next(error);
  }
}

function getQueryNumber(value: unknown, fallback: number) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function getSecurityActivityController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { symbol } = req.params;

    if (typeof symbol !== 'string' || !symbol) {
      res.status(400).json({ error: 'Symbol is required' });
      return;
    }

    const limit = getQueryNumber(req.query.limit, 10);
    const events = await getSecurityActivity(symbol, limit);

    res.status(200).json({ events });
  } catch (error) {
    next(error);
  }
}
