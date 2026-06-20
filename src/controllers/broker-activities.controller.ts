import type { Request, Response, NextFunction } from 'express';
import {
  getLatestBrokerActivity,
  getRecentBrokerActivities,
  syncBrokerActivities,
} from '../services/broker-activity.service.js';

function getQueryNumber(value: unknown, fallback: number) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getQueryString(value: unknown) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function getOptionalDate(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export async function getBrokerActivitiesController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const symbol = getQueryString(req.query.symbol);
    const activityType = getQueryString(req.query.activityType);

    const filters: {
      limit?: number;
      symbol?: string;
      activityType?: string;
    } = {
      limit: getQueryNumber(req.query.limit, 50),
    };

    if (symbol) {
      filters.symbol = symbol;
    }

    if (activityType) {
      filters.activityType = activityType;
    }

    const activities = await getRecentBrokerActivities(filters);

    res.status(200).json({ activities });
  } catch (error) {
    next(error);
  }
}

export async function getLatestBrokerActivityController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const activity = await getLatestBrokerActivity();

    res.status(200).json({ activity });
  } catch (error) {
    next(error);
  }
}

export async function syncBrokerActivitiesController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const after = getOptionalDate(req.query.after);

    const input: {
      activityType?: string;
      after?: Date;
      pageSize?: number;
      maxPages?: number;
      operation?: 'manual_admin_action';
    } = {
      activityType: getQueryString(req.query.activityType) ?? 'FILL',
      pageSize: getQueryNumber(req.query.pageSize, 100),
      maxPages: getQueryNumber(req.query.maxPages, 5),
      operation: 'manual_admin_action',
    };

    if (after) {
      input.after = after;
    }

    const result = await syncBrokerActivities(input);

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
