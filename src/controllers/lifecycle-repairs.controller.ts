import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { HttpError } from '../errors/http-error.js';
import {
  applyPositionAttributionRepair,
  diagnosePositionAttributionRepair,
  getLifecycleRepairCase,
  listLifecycleRepairCases,
} from '../services/lifecycle-repair.service.js';
import { applyLifecycleRepairSchema, diagnosePositionAttributionRepairSchema } from '../validators/lifecycle-repair.schema.js';

function actor(res: Response) {
  if (!res.locals.user) throw new HttpError(401, 'Authentication required.');
  return res.locals.user.id as number;
}

function id(value: unknown, label: string) {
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new HttpError(400, `Invalid ${label}.`);
  return parsed;
}

export async function diagnoseLifecycleRepairController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = diagnosePositionAttributionRepairSchema.parse(req.body);
    const repairCase = await diagnosePositionAttributionRepair({ ...input, actorUserId: actor(res) });
    res.status(201).json({ case: repairCase });
  } catch (error) {
    next(error instanceof ZodError ? new HttpError(400, 'Invalid lifecycle repair diagnosis request.', error.flatten()) : error);
  }
}

export async function listLifecycleRepairsController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = typeof req.query.tradingAccountId === 'string' ? id(req.query.tradingAccountId, 'TradingAccount id') : undefined;
    res.status(200).json({ cases: await listLifecycleRepairCases(tradingAccountId) });
  } catch (error) { next(error); }
}

export async function getLifecycleRepairController(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json({ case: await getLifecycleRepairCase(id(req.params.id, 'lifecycle repair case id')) }); }
  catch (error) { next(error); }
}

export async function applyLifecycleRepairController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = applyLifecycleRepairSchema.parse(req.body);
    res.status(200).json(await applyPositionAttributionRepair({ caseId: id(req.params.id, 'lifecycle repair case id'), actorUserId: actor(res), ...input }));
  } catch (error) {
    next(error instanceof ZodError ? new HttpError(400, 'Invalid lifecycle repair Apply request.', error.flatten()) : error);
  }
}
