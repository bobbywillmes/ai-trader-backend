import type { Request, Response, NextFunction } from 'express';
import { getNormalizedPositions } from '../services/positions.service.js';
import { closePosition } from '../services/close-position.service.js';

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

export async function closePositionController(req, res, next) {
  try {
    const { symbol } = req.params;

    const result = await closePosition(symbol);

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}