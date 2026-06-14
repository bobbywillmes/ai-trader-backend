import type { NextFunction, Request, Response } from 'express';
import {
  getTradePerformance,
  type TradePerformanceQuery,
} from '../services/trade-performance.service.js';

function getQueryNumber(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getQueryString(value: unknown) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function getQueryDate(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export async function tradePerformanceController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const query: TradePerformanceQuery = {};
    const dateFrom = getQueryDate(req.query.dateFrom);
    const dateTo = getQueryDate(req.query.dateTo);
    const strategyId = getQueryNumber(req.query.strategyId);
    const subscriptionId = getQueryNumber(req.query.subscriptionId);
    const exitProfileId = getQueryNumber(req.query.exitProfileId);
    const mode = getQueryString(req.query.mode);
    const limit = getQueryNumber(req.query.limit);

    if (dateFrom !== undefined) query.dateFrom = dateFrom;
    if (dateTo !== undefined) query.dateTo = dateTo;
    if (strategyId !== undefined) query.strategyId = strategyId;
    if (subscriptionId !== undefined) query.subscriptionId = subscriptionId;
    if (exitProfileId !== undefined) query.exitProfileId = exitProfileId;
    if (mode !== undefined) query.mode = mode;
    if (limit !== undefined) query.limit = limit;

    res.status(200).json(await getTradePerformance(query));
  } catch (error) {
    next(error);
  }
}
