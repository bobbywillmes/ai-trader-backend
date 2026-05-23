import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import {
  createMarketDiaryEvent,
  getMarketDiaryEvents,
} from '../services/market-state.service.js';
import { isString, isArray, isObject } from '../utils/type-check.js';

function parseLimit(value: unknown) {
  if (typeof value !== 'string') return undefined;

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.trunc(parsed);
}

export async function getMarketDiaryEventsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const limit = parseLimit(req.query.limit);
    const eventType = isString(req.query.eventType)  ? req.query.eventType  : undefined;
    const source    = isString(req.query.source)     ? req.query.source     : undefined;
    const symbol    = isString(req.query.symbol)     ? req.query.symbol     : undefined;

    const params: Parameters<typeof getMarketDiaryEvents>[0] = {};
    if (limit !== undefined)      params.limit      = limit;
    if (eventType !== undefined)  params.eventType  = eventType;
    if (source !== undefined)     params.source     = source;
    if (symbol !== undefined)     params.symbol     = symbol;

    const events = await getMarketDiaryEvents(params);

    res.status(200).json(events);
  } catch (error) {
    next(error);
  }
}

export async function createMarketDiaryEventController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!isString(req.body.eventType)) {
      res.status(400).json({ error: 'eventType is required.' });
      return;
    }
    if (!isString(req.body.summary)) {
      res.status(400).json({ error: 'summary is required.' });
      return;
    }

    const eventType   = isString(req.body.eventType)   ? req.body.eventType   : undefined;
    const source      = isString(req.body.source)      ? req.body.source      : undefined;
    const symbol      = isString(req.body.symbol)      ? req.body.symbol      : undefined;
    const summary     = isString(req.body.summary)     ? req.body.summary     : undefined;
    const details     = isString(req.body.details)     ? req.body.details     : undefined;
    const symbolsJson = isArray(req.body.symbolsJson)  ? req.body.symbolsJson : undefined;
    const payloadJson = isObject(req.body.payloadJson) ? req.body.payloadJson : undefined;

    const params: Parameters<typeof createMarketDiaryEvent>[0] = {
      eventType: '',
      summary: ''
    };
    if (eventType !== undefined)    params.eventType = eventType;
    if (source !== undefined)       params.source = source;
    if (symbol !== undefined)       params.symbol = symbol;
    if (summary !== undefined)      params.summary = summary;
    if (details !== undefined)      params.details = details;
    if (symbolsJson !== undefined)  params.symbolsJson = symbolsJson as Prisma.InputJsonValue | null;
    if (payloadJson !== undefined)  params.payloadJson = payloadJson as Prisma.InputJsonValue | null;


    const event = await createMarketDiaryEvent(params);

    res.status(201).json(event);
  } catch (error) {
    next(error);
  }
}