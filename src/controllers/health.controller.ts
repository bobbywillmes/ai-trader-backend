import type { Request, Response, NextFunction } from 'express';
import { getHealthStatus } from '../services/health.service.js';

export async function getHealthController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const health = await getHealthStatus();

    res.status(health.ok ? 200 : 503).json(health);
  } catch (error) {
    next(error);
  }
}