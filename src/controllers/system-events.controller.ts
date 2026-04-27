import type { Request, Response, NextFunction } from 'express';
import { getRecentSystemEvents } from '../services/system-event.service.js';

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