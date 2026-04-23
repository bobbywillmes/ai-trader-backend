import type { NextFunction, Request, Response } from 'express';
import { logger } from '../config/logger.js';
import { HttpError } from '../errors/http-error.js';

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  logger.error({ err: error }, 'Unhandled error');

  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      error: error.name,
      message: error.message,
      details: error.details ?? null
    });
    return;
  }

  const message =
    error instanceof Error ? error.message : 'Unknown internal server error';

  res.status(500).json({
    error: 'Internal Server Error',
    message
  });
}