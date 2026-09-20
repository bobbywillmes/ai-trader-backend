import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { marketController } from './market-data.controller.js';
import { HttpError } from '../errors/http-error.js';
import { marketIdSchema } from '../validators/market-data.schema.js';
import { getParticipationV1Assessment, latestParticipationV1Assessment, listParticipationV1Assessments, publishParticipationAssessments } from '../services/participation-assessment.service.js';

export const participationAssessmentLatestController = marketController(async (_req, res) => { res.json(await latestParticipationV1Assessment()); });
export const participationAssessmentListController = marketController(async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), beforeId: marketIdSchema.optional() }).strict().parse(req.query);
  res.json(await listParticipationV1Assessments(query.limit, query.beforeId));
});
export const participationAssessmentDetailController = marketController(async (req, res) => { res.json(await getParticipationV1Assessment(marketIdSchema.parse(req.params.id))); });
export const participationAssessmentRunController = marketController(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  try { res.json(await publishParticipationAssessments()); } catch (error) {
    // Avoid the generic calendar-specific P2002 mapping for an unresolved attempt collision.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new HttpError(409, 'PARTICIPATION_V1 attempt collision; inspect assessments before retrying.');
    throw error;
  }
});
