import type { Request, Response, NextFunction } from 'express';

import {
  getExitProfiles,
  getStrategies,
  getSubscriptionByKey,
  getSubscriptions
} from '../services/subscription.service.js';

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