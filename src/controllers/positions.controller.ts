import type { Request, Response, NextFunction } from 'express';
import { getNormalizedPositions } from '../services/positions.service.js';

export async function positionsController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const positions = await getNormalizedPositions();
    res.status(200).json(positions);
  } catch (error) {
    next(error);
  }
}