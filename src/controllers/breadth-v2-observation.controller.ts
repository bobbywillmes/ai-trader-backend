import { z } from 'zod';
import { marketController } from './market-data.controller.js';
import { marketIdSchema } from '../validators/market-data.schema.js';
import { HttpError } from '../errors/http-error.js';
import { breadthV2ObservationStatus, getBreadthV2Observation, latestBreadthV2Observation, listBreadthV2Observations, runBreadthV2Observations } from '../services/breadth-v2-measurement.service.js';

export const breadthV2ObservationStatusController = marketController(async (_req, res) => { res.json(await breadthV2ObservationStatus()); });
export const breadthV2ObservationLatestController = marketController(async (_req, res) => { res.json(await latestBreadthV2Observation()); });
export const breadthV2ObservationListController = marketController(async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), beforeId: marketIdSchema.optional() }).strict().parse(req.query);
  res.json(await listBreadthV2Observations(query.limit, query.beforeId));
});
export const breadthV2ObservationDetailController = marketController(async (req, res) => {
  const row = await getBreadthV2Observation(marketIdSchema.parse(req.params.id));
  if (!row) throw new HttpError(404, 'BREADTH_V2 observation set not found.');
  res.json(row);
});
export const breadthV2ObservationRunController = marketController(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await runBreadthV2Observations());
});
