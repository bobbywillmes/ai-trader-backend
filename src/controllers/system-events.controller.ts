import type { Request, Response, NextFunction } from 'express';
import { getRecentSystemEvents } from '../services/system-event.service.js';
import { getSecurityActivity } from '../services/system-event.service.js';

export async function systemEventsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const limit = Number(req.query.limit ?? 50);
    const events = await getRecentSystemEvents(limit);

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
