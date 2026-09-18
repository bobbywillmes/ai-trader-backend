import { z } from 'zod';
import { marketController } from './market-data.controller.js';
import { marketIdSchema } from '../validators/market-data.schema.js';
import { getBreadthObservation, ingestDueBreadthObservations, latestBreadthObservation, listBreadthObservations } from '../services/breadth-observation-ingestion.service.js';
import { HttpError } from '../errors/http-error.js';

export const breadthObservationLatestController = marketController(async (_req, res) => { res.json(await latestBreadthObservation()); });
export const breadthObservationListController = marketController(async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), beforeId: marketIdSchema.optional() }).strict().parse(req.query);
  res.json(await listBreadthObservations(query.limit, query.beforeId));
});
export const breadthObservationDetailController = marketController(async (req, res) => {
  const row = await getBreadthObservation(marketIdSchema.parse(req.params.id));
  if (!row) throw new HttpError(404, 'Breadth observation not found.');
  res.json(row);
});
// Owner-triggered bounded live ingestion only. Never performs the historical bootstrap —
// that remains the explicit `npm run breadth:bootstrap` CLI/import operation.
export const breadthObservationRunController = marketController(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await ingestDueBreadthObservations());
});
