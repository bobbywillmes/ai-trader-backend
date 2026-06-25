import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors/http-error.js';
import {
  getEntryDecisionById,
  listEntryDecisions,
  type EntryDecisionFilters,
} from '../services/entry-decision.service.js';

function getQueryString(value: unknown) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function getQueryNumber(value: unknown, field: string) {
  const raw = getQueryString(value);

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
  const raw = getQueryString(value);

  if (raw === undefined) {
    return undefined;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, `${field} must be a valid date.`);
  }

  return parsed;
}

function getQueryBoolean(value: unknown, field: string) {
  const raw = getQueryString(value);

  if (raw === undefined) {
    return undefined;
  }

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  throw new HttpError(400, `${field} must be true or false.`);
}

export async function entryDecisionsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const filters: EntryDecisionFilters = {};
    const symbol = getQueryString(req.query.symbol);
    const decisionState = getQueryString(req.query.decisionState);
    const subscriptionId = getQueryNumber(
      req.query.subscriptionId,
      'subscriptionId'
    );
    const strategyId = getQueryNumber(req.query.strategyId, 'strategyId');
    const exitProfileId = getQueryNumber(
      req.query.exitProfileId,
      'exitProfileId'
    );
    const dateFrom = getQueryDate(req.query.dateFrom, 'dateFrom');
    const dateTo = getQueryDate(req.query.dateTo, 'dateTo');
    const signalCreated = getQueryBoolean(
      req.query.signalCreated,
      'signalCreated'
    );
    const signalBlocked = getQueryBoolean(
      req.query.signalBlocked,
      'signalBlocked'
    );
    const limit = getQueryNumber(req.query.limit, 'limit');

    if (symbol !== undefined) filters.symbol = symbol;
    if (decisionState !== undefined) filters.decisionState = decisionState;
    if (subscriptionId !== undefined) filters.subscriptionId = subscriptionId;
    if (strategyId !== undefined) filters.strategyId = strategyId;
    if (exitProfileId !== undefined) filters.exitProfileId = exitProfileId;
    if (dateFrom !== undefined) filters.dateFrom = dateFrom;
    if (dateTo !== undefined) filters.dateTo = dateTo;
    if (signalCreated !== undefined) filters.signalCreated = signalCreated;
    if (signalBlocked !== undefined) filters.signalBlocked = signalBlocked;
    if (limit !== undefined) filters.limit = limit;

    res.status(200).json(await listEntryDecisions(filters));
  } catch (error) {
    next(error);
  }
}

export async function entryDecisionByIdController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'Invalid entry decision id.');
    }

    res.status(200).json(await getEntryDecisionById(id));
  } catch (error) {
    next(error);
  }
}
