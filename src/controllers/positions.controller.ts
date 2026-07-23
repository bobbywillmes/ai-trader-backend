import type { Request, Response, NextFunction } from 'express';
import { getNormalizedPositions } from '../services/positions.service.js';
import { closePosition } from '../services/close-position.service.js';
import { resolveDefaultTradingAccountId } from '../services/trading-account.service.js';

export async function positionsController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const tradingAccountId = await resolveDefaultTradingAccountId();
    const positions = await getNormalizedPositions('manual_admin_action', {
      tradingAccountId,
    });
    res.status(200).json(positions);
  } catch (error) {
    next(error);
  }
}

export async function closePositionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const trackedPositionId = Number(req.params.trackedPositionId);
    if (!Number.isInteger(trackedPositionId) || trackedPositionId <= 0) {
      res.status(400).json({ error: 'A valid trackedPositionId is required' });
      return;
    }

    const result = await closePosition(trackedPositionId);

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
