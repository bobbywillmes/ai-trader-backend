import type { Request, Response, NextFunction } from 'express';
import { getBootstrapData } from '../services/bootstrap.service.js';

export async function bootstrapController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const data = await getBootstrapData();
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
}