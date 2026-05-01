import type { Request, Response, NextFunction } from 'express';

import {
  getExitProfiles,
  getStrategies,
  getSubscriptionByKey,
  getSubscriptions
} from '../services/subscription.service.js';
import {
  createSubscriptionSchema,
  updateSubscriptionSchema,
  createExitProfileSchema,
  updateExitProfileSchema,
} from '../validators/algo-admin.schema.js';

import {
  createSubscription,
  updateSubscription,
  createExitProfile,
  updateExitProfile,
} from '../services/subscription.service.js';

function parsePositiveId(value: string) {
  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid id.');
  }

  return id;
}

export async function strategiesController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(await getStrategies());
  } catch (error) {
    next(error);
  }
}

export async function exitProfilesController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(await getExitProfiles());
  } catch (error) {
    next(error);
  }
}

export async function subscriptionsController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(await getSubscriptions());
  } catch (error) {
    next(error);
  }
}

export async function subscriptionByKeyController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const subscription = await getSubscriptionByKey(req.params.key);
    res.status(200).json(subscription);
  } catch (error) {
    next(error);
  }
}


export async function createSubscriptionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const input = createSubscriptionSchema.parse(req.body);
    const subscription = await createSubscription(input);

    res.status(201).json(subscription);
  } catch (error) {
    next(error);
  }
}

export async function updateSubscriptionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parsePositiveId(req.params.id);
    const input = updateSubscriptionSchema.parse(req.body);

    const subscription = await updateSubscription(id, input);

    res.status(200).json(subscription);
  } catch (error) {
    next(error);
  }
}

export async function createExitProfileController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const input = createExitProfileSchema.parse(req.body);
    const exitProfile = await createExitProfile(input);

    res.status(201).json(exitProfile);
  } catch (error) {
    next(error);
  }
}

export async function updateExitProfileController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parsePositiveId(req.params.id);
    const input = updateExitProfileSchema.parse(req.body);

    const exitProfile = await updateExitProfile(id, input);

    res.status(200).json(exitProfile);
  } catch (error) {
    next(error);
  }
}