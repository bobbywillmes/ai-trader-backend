import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import {
  getCurrentMarketState,
  updateCurrentMarketState,
} from '../services/market-state.service.js';
import { isString, isArray, isObject } from '../utils/type-check.js';
import { parseNullableDate } from '../utils/date.js'

export async function getCurrentMarketStateController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const state = await getCurrentMarketState();
    res.status(200).json(state);
  } catch (error) {
    next(error);
  }
}

export async function updateCurrentMarketStateController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {

    const marketBias    = isString(req.body.marketBias)    ? req.body.marketBias    : undefined;
    const riskMode      = isString(req.body.riskMode)      ? req.body.riskMode      : undefined;
    const macroSummary  = isString(req.body.macroSummary)  ? req.body.macroSummary  : undefined;
    const watchFor      = isString(req.body.watchFor)      ? req.body.watchFor      : undefined;
    const avoidBecause  = isString(req.body.avoidBecause)  ? req.body.avoidBecause  : undefined;
    const notes         = isString(req.body.notes)         ? req.body.notes         : undefined;
    const source        = isString(req.body.source)        ? req.body.source        : undefined;
    const validUntil    = isString(req.body.validUntil)    ? req.body.validUntil    : undefined;
    const lastLlmRunAt  = isString(req.body.lastLlmRunAt)  ? req.body.lastLlmRunAt  : undefined;
    const payloadJson   = isString(req.body.payloadJson)   ? req.body.payloadJson   : undefined;

    const params: Parameters<typeof updateCurrentMarketState>[0] = {};
    if (marketBias !== undefined)     params.marketBias = marketBias;
    if (riskMode !== undefined)       params.riskMode = riskMode;
    if (macroSummary !== undefined)   params.macroSummary = macroSummary;
    if (watchFor !== undefined)       params.watchFor = watchFor;
    if (avoidBecause !== undefined)   params.avoidBecause = avoidBecause;
    if (notes !== undefined)          params.notes = notes;
    if (source !== undefined)         params.source = source;
    if (validUntil !== undefined)     params.validUntil = parseNullableDate(validUntil);
    if (lastLlmRunAt !== undefined)   params.lastLlmRunAt = parseNullableDate(lastLlmRunAt);
    if (payloadJson !== undefined)    params.payloadJson = payloadJson as Prisma.InputJsonValue | null;
    


    const state = await updateCurrentMarketState(params);

    res.status(200).json(state);
  } catch (error) {
    next(error);
  }
}