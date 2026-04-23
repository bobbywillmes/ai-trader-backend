import type { NextFunction, Request, Response } from 'express';
import { logger } from '../config/logger.js';

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  logger.error({ err: error }, 'Unhandled error');

  const message =
    error instanceof Error ? error.message : 'Unknown internal server error';

  res.status(500).json({
    error: 'Internal Server Error',
    message
  });
}