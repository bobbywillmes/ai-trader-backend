import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { HttpError } from '../errors/http-error.js';
import { calendarInputSchema, calendarYearSchema, marketIdSchema, marketRangeSchema } from '../validators/market-data.schema.js';
import { deleteCalendar, listCalendar, saveCalendar } from '../services/market-calendar.service.js';
import { backfillDailyBars, marketDataStatus } from '../services/market-bar-ingestion.service.js';
import { getTrendDay, getTrendLab } from '../services/trend-lab.service.js';
import { z } from 'zod';
import { marketDateSchema } from '../validators/market-data.schema.js';

export function marketController(action: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await action(req, res); } catch (error) {
      if (error instanceof ZodError) return next(new HttpError(400, error.issues.map(x => x.message).join(' ')));
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return next(new HttpError(409, 'A calendar exception already exists for this date.'));
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return next(new HttpError(404, 'Calendar exception not found.'));
      next(error);
    }
  };
}
export const calendarListController = marketController(async (req, res) => { res.json(await listCalendar(calendarYearSchema.parse(req.query.year))); });
export const calendarCreateController = marketController(async (req, res) => { res.status(201).json(await saveCalendar(calendarInputSchema.parse(req.body))); });
export const calendarUpdateController = marketController(async (req, res) => { res.json(await saveCalendar(calendarInputSchema.parse(req.body), marketIdSchema.parse(req.params.id))); });
export const calendarDeleteController = marketController(async (req, res) => { await deleteCalendar(marketIdSchema.parse(req.params.id)); res.status(204).send(); });
export const marketDataStatusController = marketController(async (_req, res) => { res.json(await marketDataStatus()); });
export const marketBackfillController = marketController(async (req, res) => { const range = marketRangeSchema.parse(req.body); res.json(await backfillDailyBars(range.from, range.to, res.locals.user?.id)); });
export const trendLabController = marketController(async (req, res) => {
  const input = z.object({from:marketDateSchema,to:marketDateSchema,refresh:z.enum(['true','false']).optional()}).strict().parse(req.query);
  res.json(await getTrendLab(input.from,input.to,input.refresh==='true'));
});
export const trendDayController = marketController(async (req, res) => {
  const input = z.object({ datasetId: z.string().regex(/^[a-f0-9]{64}$/), profile: z.enum(['TIGHT', 'MIDDLE', 'LOOSE']), date: marketDateSchema }).strict().parse(req.query);
  res.json(getTrendDay(input.datasetId, input.profile, input.date));
});
