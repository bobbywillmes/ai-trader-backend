import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import {
  getMomentumResearchOverview,
  listMomentumResearchCandidates,
  listMomentumResearchCatalysts,
} from '../services/momentum-research.service.js';
import {
  momentumResearchCandidatesQuerySchema,
  momentumResearchCatalystsQuerySchema,
} from '../validators/momentum-research.schema.js';

function handleControllerError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'ValidationError',
      message: 'Invalid momentum research request.',
      details: error.flatten(),
    });
    return;
  }

  next(error);
}

export async function getMomentumResearchOverviewController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(await getMomentumResearchOverview());
  } catch (error) {
    handleControllerError(error, res, next);
  }
}

export async function listMomentumResearchCandidatesController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(
      await listMomentumResearchCandidates(
        momentumResearchCandidatesQuerySchema.parse(req.query)
      )
    );
  } catch (error) {
    handleControllerError(error, res, next);
  }
}

export async function listMomentumResearchCatalystsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(
      await listMomentumResearchCatalysts(
        momentumResearchCatalystsQuerySchema.parse(req.query)
      )
    );
  } catch (error) {
    handleControllerError(error, res, next);
  }
}
