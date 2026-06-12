import type { NextFunction, Request, Response } from 'express';
import { getIndexPerformance } from '../services/massive-market-data.service.js';

export async function getIndexPerformanceController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const data = await getIndexPerformance();
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
}
