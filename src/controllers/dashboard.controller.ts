import type { NextFunction, Request, Response } from 'express';
import {
  getIndexIntraday,
  getIndexPerformance,
  parseIndexChartRange,
} from '../services/live-market-data.service.js';
import { getDashboardAccountsOverview, getTradingAccountDashboard } from '../services/dashboard.service.js';
import { getDashboardReferencePrices } from '../services/dashboard-reference-prices.service.js';
import { getDashboardMarketState } from '../services/dashboard-market-state.service.js';

export async function getDashboardMarketStateController(_req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json(await getDashboardMarketState()); } catch (error) { next(error); }
}

export async function getDashboardReferencePricesController(_req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json(await getDashboardReferencePrices()); } catch (error) { next(error); }
}

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
