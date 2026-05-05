import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { getAllSecurities, findSecurity, addSecurity, updateSecurity } from '../services/securities.service.js';

function handleZodError(error: ZodError, res: Response) {
  res.status(400).json({
    error: 'ValidationError',
    message: 'Invalid securities request.',
    details: error.flatten()
  });
}

export async function getAllSecuritiesController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const securities = await getAllSecurities();
    res.status(200).json({ securities });
  } catch (error) {
      if (error instanceof ZodError) {
            handleZodError(error, res);
            return;
          }
    next(error);
  }
}

export async function findSecurityController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { symbol } = req.params;
    const security = await findSecurity(symbol);
    if (!security) {
      res.status(404).json({ error: 'Security not found' });
      return;
    }
    res.status(200).json({ security });
  } catch (error) {
      if (error instanceof ZodError) {
            handleZodError(error, res);
            return;
          }
    next(error);
  }
}

export async function addSecurityController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { symbol, name, assetType, sector, industry } = req.body;
    const security = await addSecurity(symbol, name, assetType, sector, industry);
    res.status(201).json({ security });
  } catch (error) {
        if (error instanceof ZodError) {
          handleZodError(error, res);
          return;
        }
    next(error);
  }
}

export async function updateSecurityController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { symbol } = req.params;
    const { name, enabled, assetType, sector, industry } = req.body;
    const normalizedAssetType = assetType?.trim().toUpperCase();
    const security = await updateSecurity(symbol, name, enabled, normalizedAssetType, sector, industry);
    res.status(200).json({ security });
  } catch (error) {
        if (error instanceof ZodError) {
          handleZodError(error, res);
          return;
        }
    next(error);
  }
}
