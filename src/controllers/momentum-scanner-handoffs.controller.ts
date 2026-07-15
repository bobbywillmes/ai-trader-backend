import { MomentumScannerHandoffStatus, Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { HttpError } from '../errors/http-error.js';
import {
  getMomentumScannerHandoffById,
  listMomentumScannerHandoffs,
  markMomentumScannerHandoffAcknowledged,
  markMomentumScannerHandoffFailed,
  markMomentumScannerHandoffSent,
  prepareReadyMomentumScannerHandoffs,
  type ListMomentumScannerHandoffsFilters,
  type MarkMomentumScannerHandoffOptions,
  type PrepareReadyMomentumScannerHandoffsOptions,
} from '../services/momentum-scanner-handoff.service.js';
import {
  serializeMomentumScannerHandoff,
  serializeMomentumScannerHandoffPreparation,
  serializeMomentumScannerHandoffs,
} from '../serializers/momentum-scanner-handoff.serializer.js';
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

function getBodyString(body: Record<string, unknown>, field: string) {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} must be a non-empty string.`);
  }

  return value.trim();
}

function getBodyNumber(body: Record<string, unknown>, field: string) {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a positive integer.`);
  }

  return value;
}

function getBodyBoolean(body: Record<string, unknown>, field: string) {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new HttpError(400, `${field} must be a boolean.`);
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

function getBodyMetadata(body: Record<string, unknown>) {
  const metadata = body.metadata;

  if (metadata === undefined) {
    return undefined;
  }

  if (!isObject(metadata)) {
    throw new HttpError(400, 'metadata must be an object.');
  }

  return metadata as Prisma.InputJsonValue;
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

function getHandoffIdParam(req: Request) {
  const id = req.params.id;

  if (typeof id !== 'string' || id.trim() === '') {
    throw new HttpError(400, 'Momentum scanner handoff id is required.');
  }

  return id.trim();
}

function parseMarkOptions(
  body: Record<string, unknown>
): MarkMomentumScannerHandoffOptions {
  const options: MarkMomentumScannerHandoffOptions = {};
  const now = getBodyDate(body, 'now');
  const metadata = getBodyMetadata(body);

  if (now !== undefined) options.now = now;
  if (metadata !== undefined) options.metadata = metadata;

  return options;
}

export async function listMomentumScannerHandoffsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const filters: ListMomentumScannerHandoffsFilters = {};
    const candidateId = getQueryString(req.query.candidateId);
    const symbol = getQueryString(req.query.symbol);
    const limit = getQueryNumber(req.query.limit, 'limit');
    const status = parseEnumValue(
      req.query.status,
      MomentumScannerHandoffStatus,
      'status'
    );

    if (candidateId !== undefined) filters.candidateId = candidateId;
    if (symbol !== undefined) filters.symbol = symbol;
    if (limit !== undefined) filters.limit = limit;
    if (status !== undefined) filters.status = status;

    res
      .status(200)
      .json(
        serializeMomentumScannerHandoffs(
          await listMomentumScannerHandoffs(filters)
        )
      );
  } catch (error) {
    next(error);
  }
}

export async function getMomentumScannerHandoffController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(
      serializeMomentumScannerHandoff(
        await getMomentumScannerHandoffById(getHandoffIdParam(req))
      )
    );
  } catch (error) {
    next(error);
  }
}

export async function prepareMomentumScannerHandoffsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!isObject(req.body)) {
      throw new HttpError(400, 'Momentum scanner prepare body must be an object.');
    }

    const options: PrepareReadyMomentumScannerHandoffsOptions = {};
    const candidateId = getBodyString(req.body, 'candidateId');
    const maxCandidates = getBodyNumber(req.body, 'maxCandidates');
    const minScore = getBodyNumber(req.body, 'minScore');
    const force = getBodyBoolean(req.body, 'force');
    const now = getBodyDate(req.body, 'now');
    const payloadVersion = getBodyString(req.body, 'payloadVersion');

    if (candidateId !== undefined) options.candidateId = candidateId;
    if (maxCandidates !== undefined) options.maxCandidates = maxCandidates;
    if (minScore !== undefined) options.minScore = minScore;
    if (force !== undefined) options.force = force;
    if (now !== undefined) options.now = now;
    if (payloadVersion !== undefined) options.payloadVersion = payloadVersion;

    res.status(200).json(
      serializeMomentumScannerHandoffPreparation(
        await prepareReadyMomentumScannerHandoffs(options)
      )
    );
  } catch (error) {
    next(error);
  }
}

export async function markMomentumScannerHandoffSentController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!isObject(req.body)) {
      throw new HttpError(400, 'Momentum scanner mark-sent body must be an object.');
    }

    res.status(200).json(
      serializeMomentumScannerHandoff(
        await markMomentumScannerHandoffSent(
          getHandoffIdParam(req),
          parseMarkOptions(req.body)
        )
      )
    );
  } catch (error) {
    next(error);
  }
}

export async function acknowledgeMomentumScannerHandoffController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!isObject(req.body)) {
      throw new HttpError(400, 'Momentum scanner acknowledge body must be an object.');
    }

    res.status(200).json(
      serializeMomentumScannerHandoff(
        await markMomentumScannerHandoffAcknowledged(
          getHandoffIdParam(req),
          parseMarkOptions(req.body)
        )
      )
    );
  } catch (error) {
    next(error);
  }
}

export async function markMomentumScannerHandoffFailedController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!isObject(req.body)) {
      throw new HttpError(400, 'Momentum scanner mark-failed body must be an object.');
    }

    const error = getBodyString(req.body, 'error');

    if (error === undefined) {
      throw new HttpError(400, 'error must be a non-empty string.');
    }

    res.status(200).json(
      serializeMomentumScannerHandoff(
        await markMomentumScannerHandoffFailed(
          getHandoffIdParam(req),
          error,
          parseMarkOptions(req.body)
        )
      )
    );
  } catch (caught) {
    next(caught);
  }
}
