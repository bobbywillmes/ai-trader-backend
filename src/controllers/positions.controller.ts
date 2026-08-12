import type { Request, Response, NextFunction } from 'express';
import { getNormalizedPositions } from '../services/positions.service.js';
import { closePosition } from '../services/close-position.service.js';
import { resolveDefaultTradingAccountId } from '../services/trading-account.service.js';
import { HttpError } from '../errors/http-error.js';
import { listScopedOpenPositions } from '../services/operational-scope.service.js';
import { prisma } from '../db/prisma.js';

export async function positionsController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const tradingAccountId = await resolveDefaultTradingAccountId();
    const positions = await getNormalizedPositions(
      tradingAccountId,
      'manual_admin_action'
    );
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

    const result = await closePosition(trackedPositionId, {
      mode: 'MANUAL_EMERGENCY_CLOSE',
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function scopedOpenPositionsController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const user = res.locals.user;
    if (!user) throw new HttpError(401, 'Authentication required.');
    res.status(200).json({ positions: await listScopedOpenPositions(user) });
  } catch (error) {
    next(error);
  }
}

export async function closeScopedPositionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const trackedPositionId = Number(req.params.trackedPositionId);
    const tradingAccountId = res.locals.authorizedTradingAccountId;
    if (!Number.isInteger(trackedPositionId) || trackedPositionId <= 0) {
      throw new HttpError(400, 'A valid trackedPositionId is required.');
    }
    const position = await prisma.trackedPosition.findUnique({
      where: { id: trackedPositionId }, select: { tradingAccountId: true },
    });
    if (!position) throw new HttpError(404, 'Tracked position not found.');
    if (position.tradingAccountId !== tradingAccountId) {
      throw new HttpError(409, 'Tracked position TradingAccount identity does not match the requested account.');
    }
    res.status(200).json(await closePosition(trackedPositionId, { mode: 'MANUAL_EMERGENCY_CLOSE' }));
  } catch (error) {
    next(error);
  }
}
