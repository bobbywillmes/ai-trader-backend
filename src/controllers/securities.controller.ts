import type { Request, Response, NextFunction } from 'express';
import type { AssetType } from '@prisma/client';
import { ZodError } from 'zod';
import {
  getAllSecurities,
  getSecuritiesSummary,
  findSecurity,
  addSecurity,
  updateSecurity,
} from '../services/securities.service.js';

function handleZodError(error: ZodError, res: Response) {
  res.status(400).json({
    error: 'ValidationError',
    message: 'Invalid securities request.',
    details: error.flatten(),
  });
}

function getQueryString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function getQueryNumber(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getRouteParam(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getQueryBoolean(value: unknown) {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return undefined;
}

function getSubscriptionStatusFilter(value: unknown) {
  if (
    value === 'configured' ||
    value === 'unconfigured' ||
    value === 'all'
  ) {
    return value;
  }

  return undefined;
}

function getSortBy(value: unknown) {
  if (
    value === 'symbol' ||
    value === 'name' ||
    value === 'assetType' ||
    value === 'sector' ||
    value === 'industry' ||
    value === 'enabled' ||
    value === 'subscriptionCount'
  ) {
    return value;
  }

  return undefined;
}

function getSortDirection(value: unknown) {
  if (value === 'asc' || value === 'desc') {
    return value;
  }

  return undefined;
}

export async function getAllSecuritiesController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await getAllSecurities({
      page: getQueryNumber(req.query.page),
      pageSize: getQueryNumber(req.query.pageSize),
      search: getQueryString(req.query.search),
      sector: getQueryString(req.query.sector),
      industry: getQueryString(req.query.industry),
      enabled: getQueryBoolean(req.query.enabled),
      subscriptionStatus: getSubscriptionStatusFilter(req.query.subscriptionStatus),
      sortBy: getSortBy(req.query.sortBy),
      sortDirection: getSortDirection(req.query.sortDirection),
    });

    res.status(200).json({
      // Backward-compatible field for the current admin UI.
      securities: result.data,

      // New paginated response shape for the upgraded admin UI.
      data: result.data,
      pagination: result.pagination,
      filters: result.filters,
    });
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
    const symbol = getRouteParam(req.params.symbol);

    if (!symbol) {
      res.status(400).json({ error: 'Symbol is required' });
      return;
    }

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

    const security = await addSecurity(
      symbol,
      name,
      assetType,
      sector,
      industry
    );

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
    const symbol = getRouteParam(req.params.symbol);
    const { name, enabled, assetType, sector, industry } = req.body;

    if (!symbol) {
      res.status(400).json({ error: 'Symbol is required' });
      return;
    }

    const normalizedAssetType =
      typeof assetType === 'string'
        ? (assetType.trim().toUpperCase() as AssetType)
        : undefined;

    const security = await updateSecurity(symbol, {
      name,
      enabled,
      assetType: normalizedAssetType,
      sector,
      industry,
    });

    res.status(200).json({ security });
  } catch (error) {
    if (error instanceof ZodError) {
      handleZodError(error, res);
      return;
    }

    next(error);
  }
}

export async function getSecuritiesSummaryController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const summary = await getSecuritiesSummary();

    res.status(200).json({ summary });
  } catch (error) {
    next(error);
  }
}