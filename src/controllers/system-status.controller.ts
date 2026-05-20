import type { Request, Response, NextFunction } from 'express';
import { getSystemStatus } from '../services/system-status.service.js';

export async function getSystemStatusController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const status = await getSystemStatus();

    res.status(200).json(status);
  } catch (error) {
    next(error);
  }
}