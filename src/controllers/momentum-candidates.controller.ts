import { MomentumCandidateState } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { HttpError } from '../errors/http-error.js';
import {
  expireStaleMomentumCandidates,
  generateMomentumCandidatesFromCatalysts,
  getMomentumCandidateById,
  listMomentumCandidates,
  type GenerateMomentumCandidatesArgs,
  type MomentumCandidateFilters,
} from '../services/momentum-candidates.service.js';
import {
  confirmActiveCandidates,
  confirmCandidatePrice,
  listMomentumCandidatePriceChecks,
  type ConfirmActiveCandidatesOptions,
  type ConfirmCandidatePriceOptions,
} from '../services/momentum-price-confirmation.service.js';
import { isObject } from '../utils/type-check.js';

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

function parseEnumValue<T extends Record<string, string>>(
  value: unknown,
  enumObject: T,
  field: string
): T[keyof T] | undefined {
  const raw = getQueryString(value);

  if (raw === undefined) {
    return undefined;
  }

  if (Object.values(enumObject).includes(raw)) {
    return raw as T[keyof T];
  }

  throw new HttpError(400, `${field} is not supported.`);
}

function getBodyNumber(
  body: Record<string, unknown>,
  field: string
) {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a positive integer.`);
  }

  return value;
}

function getBodyDate(body: Record<string, unknown>, field: string) {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} must be a valid date.`);
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, `${field} must be a valid date.`);
  }

  return parsed;
}

export async function listMomentumCandidatesController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const filters: MomentumCandidateFilters = {};
    const symbol = getQueryString(req.query.symbol);
    const state = parseEnumValue(
      req.query.state,
      MomentumCandidateState,
      'state'
    );
    const limit = getQueryNumber(req.query.limit, 'limit');

    if (symbol !== undefined) filters.symbol = symbol;
    if (state !== undefined) filters.state = state;
    if (limit !== undefined) filters.limit = limit;

    res.status(200).json(await listMomentumCandidates(filters));
  } catch (error) {
    next(error);
  }
}

export async function getMomentumCandidateController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;

    if (typeof id !== 'string' || id.trim() === '') {
      throw new HttpError(400, 'Momentum candidate id is required.');
    }

    res.status(200).json(await getMomentumCandidateById(id.trim()));
  } catch (error) {
    next(error);
  }
}

export async function generateMomentumCandidatesController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!isObject(req.body)) {
      throw new HttpError(400, 'Momentum candidate generation body must be an object.');
    }

    const args: GenerateMomentumCandidatesArgs = {};
    const minCatalystScore = getBodyNumber(req.body, 'minCatalystScore');
    const expiresInHours = getBodyNumber(req.body, 'expiresInHours');
    const take = getBodyNumber(req.body, 'take');
    const recentSince = getBodyDate(req.body, 'recentSince');

    if (minCatalystScore !== undefined) args.minCatalystScore = minCatalystScore;
    if (expiresInHours !== undefined) args.expiresInHours = expiresInHours;
    if (take !== undefined) args.take = take;
    if (recentSince !== undefined) args.recentSince = recentSince;

    res.status(200).json(await generateMomentumCandidatesFromCatalysts(args));
  } catch (error) {
    next(error);
  }
}

export async function expireStaleMomentumCandidatesController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!isObject(req.body)) {
      throw new HttpError(400, 'Momentum candidate expiration body must be an object.');
    }

    const now = getBodyDate(req.body, 'now');

    res.status(200).json(
      await expireStaleMomentumCandidates(
        now === undefined ? {} : { now }
      )
    );
  } catch (error) {
    next(error);
  }
}

function getCandidateIdParam(req: Request) {
  const id = req.params.id;

  if (typeof id !== 'string' || id.trim() === '') {
    throw new HttpError(400, 'Momentum candidate id is required.');
  }

  return id.trim();
}

function parsePriceConfirmationOptions(
  body: Record<string, unknown>
): ConfirmCandidatePriceOptions {
  const options: ConfirmCandidatePriceOptions = {};
  const now = getBodyDate(body, 'now');
  const recentWindowMinutes = getBodyNumber(body, 'recentWindowMinutes');
  const lookbackMinutes = getBodyNumber(body, 'lookbackMinutes');

  if (now !== undefined) options.now = now;
  if (recentWindowMinutes !== undefined) {
    options.recentWindowMinutes = recentWindowMinutes;
  }
  if (lookbackMinutes !== undefined) options.lookbackMinutes = lookbackMinutes;

  return options;
}

export async function confirmMomentumCandidatePriceController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!isObject(req.body)) {
      throw new HttpError(400, 'Momentum price confirmation body must be an object.');
    }

    res.status(200).json(
      await confirmCandidatePrice(
        getCandidateIdParam(req),
        parsePriceConfirmationOptions(req.body)
      )
    );
  } catch (error) {
    next(error);
  }
}

export async function confirmMomentumCandidatePricesController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!isObject(req.body)) {
      throw new HttpError(400, 'Momentum price confirmation body must be an object.');
    }

    const options: ConfirmActiveCandidatesOptions =
      parsePriceConfirmationOptions(req.body);
    const maxCandidates = getBodyNumber(req.body, 'maxCandidates');
    const minCatalystScore = getBodyNumber(req.body, 'minCatalystScore');
    const state = parseEnumValue(
      req.body.state,
      MomentumCandidateState,
      'state'
    );

    if (maxCandidates !== undefined) options.maxCandidates = maxCandidates;
    if (minCatalystScore !== undefined) {
      options.minCatalystScore = minCatalystScore;
    }
    if (state !== undefined) options.state = state;

    res.status(200).json(await confirmActiveCandidates(options));
  } catch (error) {
    next(error);
  }
}

export async function listMomentumCandidatePriceChecksController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const options: { limit?: number } = {};
    const limit = getQueryNumber(req.query.limit, 'limit');

    if (limit !== undefined) options.limit = limit;

    res.status(200).json(
      await listMomentumCandidatePriceChecks(
        getCandidateIdParam(req),
        options
      )
    );
  } catch (error) {
    next(error);
  }
}
