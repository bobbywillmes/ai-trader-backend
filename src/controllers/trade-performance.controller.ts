import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors/http-error.js';
import {
  getTradePerformance,
  type TradePerformanceQuery,
  type TradePerformanceOutcome,
  type TradePerformanceSortBy,
  type TradePerformanceSortDirection,
} from '../services/trade-performance.service.js';

function getQueryString(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function getQueryNumber(value: unknown, field: string) {
  const raw = getQueryString(value, field);

  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `${field} must be a positive integer.`);
  }

  return parsed;
}

function getQueryDate(value: unknown, field: string) {
  const raw = getQueryString(value, field);

  if (raw === undefined) {
    return undefined;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, `${field} must be a valid date.`);
  }

  return parsed;
}

function getOutcome(value: unknown): TradePerformanceOutcome | undefined {
  const raw = getQueryString(value, 'outcome');

  if (raw === undefined) {
    return undefined;
  }

  if (
    raw === 'all' ||
    raw === 'winner' ||
    raw === 'loser' ||
    raw === 'breakeven'
  ) {
    return raw;
  }

  throw new HttpError(400, 'outcome is not supported.');
}

function getMode(value: unknown) {
  const raw = getQueryString(value, 'mode');

  if (raw === undefined) {
    return undefined;
  }

  if (raw === 'paper' || raw === 'live') {
    return raw;
  }

  throw new HttpError(400, 'mode must be paper or live.');
}

function getSortBy(value: unknown): TradePerformanceSortBy | undefined {
  const raw = getQueryString(value, 'sortBy');

  if (raw === undefined) {
    return undefined;
  }

  if (
    raw === 'closedAt' ||
    raw === 'openedAt' ||
    raw === 'symbol' ||
    raw === 'realizedPnl' ||
    raw === 'returnPct' ||
    raw === 'holdingDurationMs'
  ) {
    return raw;
  }

  throw new HttpError(400, 'sortBy is not supported.');
}

function getSortDirection(
  value: unknown
): TradePerformanceSortDirection | undefined {
  const raw = getQueryString(value, 'sortDirection');

  if (raw === undefined) {
    return undefined;
  }

  if (raw === 'asc' || raw === 'desc') {
    return raw;
  }

  throw new HttpError(400, 'sortDirection must be asc or desc.');
}

export async function tradePerformanceController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const query: TradePerformanceQuery = {};
    const dateFrom = getQueryDate(req.query.dateFrom, 'dateFrom');
    const dateTo = getQueryDate(req.query.dateTo, 'dateTo');
    const symbol = getQueryString(req.query.symbol, 'symbol');
    const strategyId = getQueryNumber(req.query.strategyId, 'strategyId');
    const subscriptionId = getQueryNumber(
      req.query.subscriptionId,
      'subscriptionId'
    );
    const exitProfileId = getQueryNumber(
      req.query.exitProfileId,
      'exitProfileId'
    );
    const exitReason = getQueryString(req.query.exitReason, 'exitReason');
    const outcome = getOutcome(req.query.outcome);
    const mode = getMode(req.query.mode);
    const limit = getQueryNumber(req.query.limit, 'limit');
    const page = getQueryNumber(req.query.page, 'page');
    const pageSize = getQueryNumber(req.query.pageSize, 'pageSize');
    const sortBy = getSortBy(req.query.sortBy);
    const sortDirection = getSortDirection(req.query.sortDirection);

    if (dateFrom !== undefined) query.dateFrom = dateFrom;
    if (dateTo !== undefined) query.dateTo = dateTo;
    if (symbol !== undefined) query.symbol = symbol;
    if (strategyId !== undefined) query.strategyId = strategyId;
    if (subscriptionId !== undefined) query.subscriptionId = subscriptionId;
    if (exitProfileId !== undefined) query.exitProfileId = exitProfileId;
    if (exitReason !== undefined) query.exitReason = exitReason;
    if (outcome !== undefined) query.outcome = outcome;
    if (mode !== undefined) query.mode = mode;
    if (limit !== undefined) query.limit = limit;
    if (page !== undefined) query.page = page;
    if (pageSize !== undefined) query.pageSize = pageSize;
    if (sortBy !== undefined) query.sortBy = sortBy;
    if (sortDirection !== undefined) query.sortDirection = sortDirection;

    res.status(200).json(await getTradePerformance(query));
  } catch (error) {
    next(error);
  }
}
