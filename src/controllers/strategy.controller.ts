import type { NextFunction, Request, Response } from 'express';

import { getStrategies } from '../services/strategy.service.js';
import {
  getStrategy,
  getStrategyChangeImpact,
} from '../services/strategy.service.js';
import { HttpError } from '../errors/http-error.js';
import { strategyDetailQuerySchema } from '../validators/strategy.validator.js';

function parseStrategyId(value: unknown) {
  const id = typeof value === 'string' ? Number(value) : Number.NaN;

  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Strategy id must be a positive integer.');
  }

  return id;
}

function parseStrategyDetailQuery(value: unknown) {
  const result = strategyDetailQuerySchema.safeParse(value);

  if (!result.success) {
    throw new HttpError(400, 'Invalid strategy detail query.', result.error.issues);
  }

  return result.data;
}

export async function strategiesController(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.status(200).json(await getStrategies());
  } catch (error) {
    next(error);
  }
}

export async function strategyController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseStrategyId(req.params.id);
    const query = parseStrategyDetailQuery(req.query);
    res.status(200).json(await getStrategy(id, query));
  } catch (error) {
    next(error);
  }
}

export async function strategyChangeImpactController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseStrategyId(req.params.id);
    res.status(200).json(await getStrategyChangeImpact(id));
  } catch (error) {
    next(error);
  }
}
