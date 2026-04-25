import type { Request, Response, NextFunction } from 'express';
import { getRecentOrderIntents } from '../services/order-audit.service.js';

export async function orderIntentsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const limit = Number(req.query.limit ?? 50);
    const intents = await getRecentOrderIntents(limit);

    res.status(200).json(intents);
  } catch (error) {
    next(error);
  }
}