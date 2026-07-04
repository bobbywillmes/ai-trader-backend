import {
  CatalystEventType,
  CatalystSource,
  CatalystTier,
} from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors/http-error.js';
import { ingestMassiveNewsPayload } from '../services/catalyst-news-ingestion.service.js';
import {
  getCatalystEventById,
  listCatalystEvents,
  type CatalystEventFilters,
} from '../services/catalyst-events.service.js';
import { isObject } from '../utils/type-check.js';
import { runMassiveNewsWorkerOnce } from '../workers/massive-news.worker.js';

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

export async function listCatalystEventsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const filters: CatalystEventFilters = {};
    const symbol = getQueryString(req.query.symbol);
    const limit = getQueryNumber(req.query.limit, 'limit');
    const source = parseEnumValue(
      req.query.source,
      CatalystSource,
      'source'
    );
    const eventType = parseEnumValue(
      req.query.eventType,
      CatalystEventType,
      'eventType'
    );
    const eventTier = parseEnumValue(
      req.query.eventTier,
      CatalystTier,
      'eventTier'
    );

    if (symbol !== undefined) filters.symbol = symbol;
    if (limit !== undefined) filters.limit = limit;
    if (source !== undefined) filters.source = source;
    if (eventType !== undefined) filters.eventType = eventType;
    if (eventTier !== undefined) filters.eventTier = eventTier;

    res.status(200).json(await listCatalystEvents(filters));
  } catch (error) {
    next(error);
  }
}

export async function getCatalystEventController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id;

    if (typeof id !== 'string' || id.trim() === '') {
      throw new HttpError(400, 'Catalyst event id is required.');
    }

    res.status(200).json(await getCatalystEventById(id.trim()));
  } catch (error) {
    next(error);
  }
}

export async function ingestMassiveNewsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!isObject(req.body)) {
      throw new HttpError(400, 'Massive news payload must be an object.');
    }

    const result = await ingestMassiveNewsPayload(req.body);

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

export async function runMassiveNewsWorkerOnceController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
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
