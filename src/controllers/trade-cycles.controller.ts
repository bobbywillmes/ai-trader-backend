import type { NextFunction, Request, Response } from 'express';
import {
  getTradeCycleById,
  listTradeCycles,
  type TradeCycleFilters,
} from '../services/trade-cycles.service.js';

function getQueryString(value: unknown) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function getQueryNumber(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getQueryDate(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseStatus(value: unknown): TradeCycleFilters['status'] {
  const status = getQueryString(value);

  if (status === 'open' || status === 'closed' || status === 'closing') {
    return status;
  }

  return undefined;
}

export async function tradeCyclesController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const filters: TradeCycleFilters = {};
    const symbol = getQueryString(req.query.symbol);
    const status = parseStatus(req.query.status);
    const dateFrom = getQueryDate(req.query.dateFrom);
    const dateTo = getQueryDate(req.query.dateTo);
    const strategyId = getQueryNumber(req.query.strategyId);
    const subscriptionId = getQueryNumber(req.query.subscriptionId);
    const exitProfileId = getQueryNumber(req.query.exitProfileId);
    const exitReason = getQueryString(req.query.exitReason);
    const mode = getQueryString(req.query.mode);
    const limit = getQueryNumber(req.query.limit);

    if (symbol !== undefined) filters.symbol = symbol;
    if (status !== undefined) filters.status = status;
    if (dateFrom !== undefined) filters.dateFrom = dateFrom;
    if (dateTo !== undefined) filters.dateTo = dateTo;
    if (strategyId !== undefined) filters.strategyId = strategyId;
    if (subscriptionId !== undefined) filters.subscriptionId = subscriptionId;
    if (exitProfileId !== undefined) filters.exitProfileId = exitProfileId;
    if (exitReason !== undefined) filters.exitReason = exitReason;
    if (mode !== undefined) filters.mode = mode;
    if (limit !== undefined) filters.limit = limit;

    const result = await listTradeCycles(filters);

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function tradeCycleByIdController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid trade cycle id.',
      });
      return;
    }

    const result = await getTradeCycleById(id);

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
