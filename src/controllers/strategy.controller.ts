import type { NextFunction, Request, Response } from 'express';

import { getStrategies } from '../services/strategy.service.js';
import {
  getStrategy,
  getStrategyChangeImpact,
  updateStrategyEnabled,
} from '../services/strategy.service.js';
import { HttpError } from '../errors/http-error.js';
import {
  strategyDetailQuerySchema,
  activateStrategyMarketPolicyRevisionSchema,
  saveStrategyMarketPolicyRevisionSchema,
  strategyMarketPolicyNoteSchema,
  updateStrategyEnabledSchema,
} from '../validators/strategy.validator.js';
import {
  activateStrategyMarketPolicyRevision,
  createStrategyMarketPolicy,
  getStrategyMarketPolicy,
  prepareStrategyMarketPolicyRevision,
  saveStrategyMarketPolicyRevision,
  validateStrategyMarketPolicyRevision,
} from '../services/strategy-market-policy.service.js';

function parseStrategyId(value: unknown) {
  const id = typeof value === 'string' ? Number(value) : Number.NaN;

  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Strategy id must be a positive integer.');
  }

  return id;
}

function parsePositiveId(value: unknown, label: string) {
  const id = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `${label} must be a positive integer.`);
  return id;
}

function actorId(res: Response) {
  const actor = res.locals.user;
  if (!actor) throw new HttpError(401, 'Authentication required.');
  return actor.id;
}

function parseStrategyDetailQuery(value: unknown) {
  const result = strategyDetailQuerySchema.safeParse(value);

  if (!result.success) {
    throw new HttpError(400, 'Invalid strategy detail query.', result.error.issues);
  }

  return result.data;
}

function parseUpdateStrategyEnabledBody(value: unknown) {
  const result = updateStrategyEnabledSchema.safeParse(value);

  if (!result.success) {
    throw new HttpError(400, 'Invalid strategy update.', result.error.issues);
  }

  return result.data;
}

export async function strategiesController(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.status(200).json(await getStrategies());
  } catch (error) {
    next(error);
  }
}

export async function strategyController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseStrategyId(req.params.id);
    const query = parseStrategyDetailQuery(req.query);
    res.status(200).json(await getStrategy(id, query));
  } catch (error) {
    next(error);
  }
}

export async function strategyChangeImpactController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseStrategyId(req.params.id);
    res.status(200).json(await getStrategyChangeImpact(id));
  } catch (error) {
    next(error);
  }
}

export async function updateStrategyController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseStrategyId(req.params.id);
    const input = parseUpdateStrategyEnabledBody(req.body);
    const actor = res.locals.user;

    if (!actor) {
      throw new HttpError(401, 'Authentication required.');
    }

    res.status(200).json(await updateStrategyEnabled(id, input, actor.id));
  } catch (error) {
    next(error);
  }
}

export async function strategyMarketPolicyController(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json(await getStrategyMarketPolicy(parseStrategyId(req.params.id))); } catch (error) { next(error); }
}

export async function createStrategyMarketPolicyController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = strategyMarketPolicyNoteSchema.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Invalid policy request.', body.error.issues);
    res.status(201).json(await createStrategyMarketPolicy(parseStrategyId(req.params.id), actorId(res), body.data.changeNote));
  } catch (error) { next(error); }
}

export async function prepareStrategyMarketPolicyRevisionController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = strategyMarketPolicyNoteSchema.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Invalid revision request.', body.error.issues);
    res.status(201).json(await prepareStrategyMarketPolicyRevision(parseStrategyId(req.params.id), actorId(res), body.data.changeNote));
  } catch (error) { next(error); }
}

export async function saveStrategyMarketPolicyRevisionController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = saveStrategyMarketPolicyRevisionSchema.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Invalid policy revision.', body.error.issues);
    res.status(200).json(await saveStrategyMarketPolicyRevision(parseStrategyId(req.params.id), parsePositiveId(req.params.revisionId, 'Revision id'), body.data, actorId(res)));
  } catch (error) { next(error); }
}

export async function validateStrategyMarketPolicyRevisionController(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json(await validateStrategyMarketPolicyRevision(parseStrategyId(req.params.id), parsePositiveId(req.params.revisionId, 'Revision id'))); } catch (error) { next(error); }
}

export async function activateStrategyMarketPolicyRevisionController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = activateStrategyMarketPolicyRevisionSchema.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'Invalid activation request.', body.error.issues);
    res.status(200).json(await activateStrategyMarketPolicyRevision(parseStrategyId(req.params.id), parsePositiveId(req.params.revisionId, 'Revision id'), body.data.expectedConfigurationFingerprint, actorId(res)));
  } catch (error) { next(error); }
}
