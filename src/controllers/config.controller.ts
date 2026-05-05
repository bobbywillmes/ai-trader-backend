import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

import {
  getRuntimeTradingConfig,
  updateRuntimeSettings
} from '../services/config.service.js';
import {
  updateRuntimeSettingsSchema
} from '../validators/config.schema.js';

function handleZodError(error: ZodError, res: Response) {
  res.status(400).json({
    error: 'ValidationError',
    message: 'Invalid config request.',
    details: error.flatten()
  });
}

export async function getConfigController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const config = await getRuntimeTradingConfig();
    res.status(200).json(config);
  } catch (error) {
    next(error);
  }
}

export async function updateSettingsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const input = updateRuntimeSettingsSchema.parse(req.body);
    const config = await updateRuntimeSettings(input);
    res.status(200).json(config);
  } catch (error) {
    if (error instanceof ZodError) {
      handleZodError(error, res);
      return;
    }

    next(error);
  }
}
