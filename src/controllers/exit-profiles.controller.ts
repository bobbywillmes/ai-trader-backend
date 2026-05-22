import type { Request, Response, NextFunction } from 'express';
import { createExitProfileSchema } from '../validators/algo-admin.schema.js';
import { 
  getExitProfiles,
  findExitProfile,
  createExitProfile,
  updateExitProfile,
 } from '../services/exit-profiles.service.js';

function getRouteParam(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export async function getAllExitProfilesController(
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

export async function findExitProfileController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const key = getRouteParam(req.params.key);
  if (!key) {
    res.status(400).json({ error: 'Exit profile key is required' });
    return;
  }

  try {
    const exitProfile = await findExitProfile(key);
    res.status(200).json(exitProfile);
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
  const key = getRouteParam(req.params.key);
  if (!key) {
    res.status(400).json({ error: 'Exit profile key is required' });
    return;
  }

  try {
    const exitProfile = await updateExitProfile(key, req.body);
    res.status(200).json(exitProfile);
  } catch (error: any) {
    if (error.statusCode === 400 && error.activeSubscriptions) {
      res.status(400).json({
        error: error.message,
        activeSubscriptions: error.activeSubscriptions,
      });
      return;
    }
    next(error);
  }
}