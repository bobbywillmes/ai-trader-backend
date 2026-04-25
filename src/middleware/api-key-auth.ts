import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const providedKey = req.header('AI_TRADER_BACKEND_API_KEY');

  if (!providedKey || providedKey !== env.AI_TRADER_BACKEND_API_KEY) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid API key.'
    });
    return;
  }

  next();
}