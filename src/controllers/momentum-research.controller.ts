import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import {
  getMomentumResearchOverview,
  getMomentumResearchCandidate,
  getMomentumSymbolResearch,
  listMomentumResearchCandidates,
  listMomentumResearchCatalysts,
} from '../services/momentum-research.service.js';
import {
  momentumResearchCandidatesQuerySchema,
  momentumResearchCandidateIdSchema,
  momentumResearchCatalystsQuerySchema,
  momentumResearchSymbolSchema,
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

export async function getMomentumResearchCandidateController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(
      await getMomentumResearchCandidate(
        momentumResearchCandidateIdSchema.parse(req.params.candidateId)
      )
    );
  } catch (error) {
    handleControllerError(error, res, next);
  }
}

export async function getMomentumSymbolResearchController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(
      await getMomentumSymbolResearch(
        momentumResearchSymbolSchema.parse(req.params.symbol)
      )
    );
  } catch (error) {
    handleControllerError(error, res, next);
  }
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
