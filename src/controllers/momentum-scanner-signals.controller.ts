import { MomentumScannerHandoffStatus, Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { HttpError } from '../errors/http-error.js';
import {
  generateMomentumCandidatesFromCatalysts,
  type GenerateMomentumCandidatesArgs,
} from '../services/momentum-candidates.service.js';
import {
  confirmActiveCandidates,
  type ConfirmActiveCandidatesOptions,
} from '../services/momentum-price-confirmation.service.js';
import {
  cancelStalePendingHandoffs,
  listMomentumScannerHandoffs,
  markMomentumScannerHandoffFailed,
  markMomentumScannerHandoffSent,
  prepareReadyMomentumScannerHandoffs,
  type CancelStalePendingHandoffsOptions,
  type ListMomentumScannerHandoffsFilters,
  type MarkMomentumScannerHandoffOptions,
  type PrepareReadyMomentumScannerHandoffsOptions,
} from '../services/momentum-scanner-handoff.service.js';
import {
  serializeMomentumCandidatePriceCheck,
  serializeMomentumPriceConfirmationResponse,
} from '../serializers/momentum-candidate-price-check.serializer.js';
import { isObject } from '../utils/type-check.js';
import { runMassiveNewsWorkerOnce } from '../workers/massive-news.worker.js';

const DEFAULT_MARK_FAILED_ERROR =
  'n8n momentum scanner workflow reported failure';

function getRequestBody(req: Request, label: string) {
  if (req.body === undefined) {
    return {};
  }

  if (!isObject(req.body)) {
    throw new HttpError(400, `${label} body must be an object.`);
  }

  return req.body;
}

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

export async function runMomentumScannerNewsWorkerSignalController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    getRequestBody(req, 'Momentum scanner news worker');

    const result = await runMassiveNewsWorkerOnce({
      enabled: true,
    });

    res.status(200).json({
      ok: true,
      result,
    });
  } catch (error) {
    next(error);
  }
}

export async function generateMomentumScannerCandidatesSignalController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const body = getRequestBody(req, 'Momentum scanner candidate generation');
    const args: GenerateMomentumCandidatesArgs = {};
    const minCatalystScore = getBodyNumber(body, 'minCatalystScore');
    const take = getBodyNumber(body, 'take');
    const expiresInHours = getBodyNumber(body, 'expiresInHours');

    if (minCatalystScore !== undefined) args.minCatalystScore = minCatalystScore;
    if (take !== undefined) args.take = take;
    if (expiresInHours !== undefined) args.expiresInHours = expiresInHours;

    res.status(200).json(await generateMomentumCandidatesFromCatalysts(args));
  } catch (error) {
    next(error);
  }
}

export async function confirmMomentumScannerPricesSignalController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const body = getRequestBody(req, 'Momentum scanner price confirmation');
    const options: ConfirmActiveCandidatesOptions = {};
    const maxCandidates = getBodyNumber(body, 'maxCandidates');

    if (maxCandidates !== undefined) options.maxCandidates = maxCandidates;

    const summary = await confirmActiveCandidates(options);

    res.status(200).json(
      serializeMomentumPriceConfirmationResponse({
        ...summary,
        results: summary.results.map((result) => ({
          ...result,
          priceCheck: serializeMomentumCandidatePriceCheck(result.priceCheck),
        })),
      })
    );
  } catch (error) {
    next(error);
  }
}

export async function prepareMomentumScannerHandoffsSignalController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const body = getRequestBody(req, 'Momentum scanner handoff prepare');
    const options: PrepareReadyMomentumScannerHandoffsOptions = {};
    const maxCandidates = getBodyNumber(body, 'maxCandidates');
    const minScore = getBodyNumber(body, 'minScore');
    const force = getBodyBoolean(body, 'force');

    if (maxCandidates !== undefined) options.maxCandidates = maxCandidates;
    if (minScore !== undefined) options.minScore = minScore;
    if (force !== undefined) options.force = force;

    res.status(200).json(await prepareReadyMomentumScannerHandoffs(options));
  } catch (error) {
    next(error);
  }
}

export async function listMomentumScannerHandoffsSignalController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const filters: ListMomentumScannerHandoffsFilters = {};
    const status =
      parseEnumValue(req.query.status, MomentumScannerHandoffStatus, 'status') ??
      MomentumScannerHandoffStatus.PENDING;
    const take = getQueryNumber(req.query.take, 'take');
    const symbol = getQueryString(req.query.symbol);

    filters.status = status;
    if (take !== undefined) filters.limit = take;
    if (symbol !== undefined) filters.symbol = symbol;

    const cancelOptions: CancelStalePendingHandoffsOptions = {};

    if (take !== undefined) cancelOptions.limit = take;
    if (symbol !== undefined) cancelOptions.symbol = symbol;

    await cancelStalePendingHandoffs(cancelOptions);

    if (status === MomentumScannerHandoffStatus.PENDING) {
      filters.currentlyEligibleOnly = true;
    }

    res.status(200).json(await listMomentumScannerHandoffs(filters));
  } catch (error) {
    next(error);
  }
}

export async function markMomentumScannerHandoffSentSignalController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const body = getRequestBody(req, 'Momentum scanner mark-sent');

    res.status(200).json(
      await markMomentumScannerHandoffSent(
        getHandoffIdParam(req),
        parseMarkOptions(body)
      )
    );
  } catch (error) {
    next(error);
  }
}

export async function markMomentumScannerHandoffFailedSignalController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const body = getRequestBody(req, 'Momentum scanner mark-failed');
    const reportedError = getBodyString(body, 'error');

    res.status(200).json(
      await markMomentumScannerHandoffFailed(
        getHandoffIdParam(req),
        reportedError ?? DEFAULT_MARK_FAILED_ERROR,
        parseMarkOptions(body)
      )
    );
  } catch (error) {
    next(error);
  }
}
