import type { Request, Response, NextFunction } from 'express';
import {
  getTrackedPositions,
  getOpenTrackedPositions,
} from '../services/position-tracking.service.js';

export async function trackedPositionsController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const positions = await getTrackedPositions();
    res.status(200).json(positions);
  } catch (error) {
    next(error);
  }
}

export async function openTrackedPositionsController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const positions = await getOpenTrackedPositions();
    res.status(200).json(positions);
  } catch (error) {
    next(error);
  }
}