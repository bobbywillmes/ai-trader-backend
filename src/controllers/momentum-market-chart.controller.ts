import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { getMomentumMarketChart } from '../services/momentum-market-chart.service.js';
import {
  momentumMarketChartQuerySchema,
  momentumMarketChartSymbolSchema,
} from '../validators/momentum-market-chart.schema.js';

export async function getMomentumMarketChartController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    res.status(200).json(
      await getMomentumMarketChart(
        momentumMarketChartSymbolSchema.parse(req.params.symbol),
        momentumMarketChartQuerySchema.parse(req.query)
      )
    );
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid momentum market chart request.',
        details: error.flatten(),
      });
      return;
    }

    next(error);
  }
}
