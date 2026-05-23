import type { NextFunction, Request, Response } from 'express';
import { getEtfWatchContext } from '../services/etf-watch-context.service.js';

export async function getEtfWatchContextController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const context = await getEtfWatchContext();
    res.status(200).json(context);
  } catch (error) {
    next(error);
  }
}