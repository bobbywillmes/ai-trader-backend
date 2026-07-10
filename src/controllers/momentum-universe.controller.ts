import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import {
  createMomentumUniverseMember,
  deleteMomentumUniverseMember,
  listMomentumUniverseMembers,
  updateMomentumUniverseMember,
} from '../services/momentum-universe.service.js';
import {
  createMomentumUniverseMemberSchema,
  listMomentumUniverseSchema,
  momentumUniverseMemberIdSchema,
  updateMomentumUniverseMemberSchema,
} from '../validators/momentum-universe.schema.js';

function handleControllerError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'ValidationError',
      message: 'Invalid momentum universe request.',
      details: error.flatten(),
    });
    return;
  }

  next(error);
}

export async function listMomentumUniverseController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(
      await listMomentumUniverseMembers(listMomentumUniverseSchema.parse(req.query))
    );
  } catch (error) {
    handleControllerError(error, res, next);
  }
}

export async function createMomentumUniverseController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(201).json(
      await createMomentumUniverseMember(createMomentumUniverseMemberSchema.parse(req.body))
    );
  } catch (error) {
    handleControllerError(error, res, next);
  }
}

export async function updateMomentumUniverseController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = momentumUniverseMemberIdSchema.parse(req.params.id);
    const input = updateMomentumUniverseMemberSchema.parse(req.body);

    res.status(200).json(await updateMomentumUniverseMember(id, input));
  } catch (error) {
    handleControllerError(error, res, next);
  }
}

export async function deleteMomentumUniverseController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = momentumUniverseMemberIdSchema.parse(req.params.id);

    res.status(200).json(await deleteMomentumUniverseMember(id));
  } catch (error) {
    handleControllerError(error, res, next);
  }
}
