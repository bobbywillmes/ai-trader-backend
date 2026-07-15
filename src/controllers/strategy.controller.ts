import type { NextFunction, Request, Response } from 'express';

import { getStrategies } from '../services/strategy.service.js';

export async function strategiesController(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.status(200).json(await getStrategies());
  } catch (error) {
    next(error);
  }
}
