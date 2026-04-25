import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

import {
  addAllowedTicker,
  getAllowedTickers,
  getRuntimeTradingConfig,
  removeAllowedTicker,
  updateRuntimeSettings
} from '../services/config.service.js';
import {
  allowedTickerBodySchema,
  allowedTickerParamsSchema,
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

export async function getAllowedTickersController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const allowedTickers = await getAllowedTickers();
    res.status(200).json({ allowedTickers });
  } catch (error) {
    next(error);
  }
}

export async function addAllowedTickerController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { symbol } = allowedTickerBodySchema.parse(req.body);
    const allowedTickers = await addAllowedTicker(symbol);
    res.status(201).json({ allowedTickers });
  } catch (error) {
    if (error instanceof ZodError) {
      handleZodError(error, res);
      return;
    }

    next(error);
  }
}

export async function removeAllowedTickerController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { symbol } = allowedTickerParamsSchema.parse(req.params);
    const allowedTickers = await removeAllowedTicker(symbol);
    res.status(200).json({ allowedTickers });
  } catch (error) {
    if (error instanceof ZodError) {
      handleZodError(error, res);
      return;
    }

    next(error);
  }
}