import type { NextFunction, Request, Response } from 'express';
import {
  getIndexIntraday,
  getIndexPerformance,
  parseIndexChartRange,
} from '../services/massive-market-data.service.js';
import { getDashboardAccountsOverview, getTradingAccountDashboard } from '../services/dashboard.service.js';

export async function getTradingAccountDashboardController(req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json(await getTradingAccountDashboard(Number(req.params.id))); } catch (error) { next(error); }
}

export async function getDashboardAccountsOverviewController(_req: Request, res: Response, next: NextFunction) {
  try {
    if (!res.locals.user) throw new Error('Authenticated user context is missing.');
    res.status(200).json(await getDashboardAccountsOverview(res.locals.user));
  } catch (error) { next(error); }
}

export async function getIndexPerformanceController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const data = await getIndexPerformance();
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
}

export async function getIndexIntradayController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const data = await getIndexIntraday(parseIndexChartRange(req.query.range));
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
}
