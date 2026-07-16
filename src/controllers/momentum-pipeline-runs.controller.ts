import type { NextFunction, Request, Response } from 'express';

import {
  completeMomentumPipelineRun,
  failMomentumPipelineRun,
  getLatestMomentumPipelineRuns,
  getMomentumPipelineRun,
  listMomentumPipelineRuns,
  recordMomentumPipelineStage,
  startMomentumPipelineRun,
} from '../services/momentum-pipeline-run.service.js';
import {
  completeMomentumPipelineRunSchema,
  failMomentumPipelineRunSchema,
  listMomentumPipelineRunsSchema,
  momentumPipelineRunIdSchema,
  momentumPipelineStageSchema,
  recordMomentumPipelineStageSchema,
  startMomentumPipelineRunSchema,
} from '../validators/momentum-pipeline-run.schema.js';

export async function startMomentumPipelineRunController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = startMomentumPipelineRunSchema.parse(req.body ?? {});
    const run = await startMomentumPipelineRun(body);
    res.status(201).json({ runId: run.id, status: run.status, startedAt: run.startedAt });
  } catch (error) { next(error); }
}

export async function recordMomentumPipelineStageController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = recordMomentumPipelineStageSchema.parse(req.body ?? {});
    res.status(200).json(await recordMomentumPipelineStage({
      runId: momentumPipelineRunIdSchema.parse(req.params.runId),
      stage: momentumPipelineStageSchema.parse(req.params.stage),
      ...body,
    }));
  } catch (error) { next(error); }
}

export async function completeMomentumPipelineRunController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = completeMomentumPipelineRunSchema.parse(req.body ?? {});
    res.status(200).json(await completeMomentumPipelineRun({
      runId: momentumPipelineRunIdSchema.parse(req.params.runId),
      ...(body.status === undefined ? {} : { status: body.status }),
    }));
  } catch (error) { next(error); }
}

export async function failMomentumPipelineRunController(req: Request, res: Response, next: NextFunction) {
  try {
    const body = failMomentumPipelineRunSchema.parse(req.body ?? {});
    res.status(200).json(await failMomentumPipelineRun({
      runId: momentumPipelineRunIdSchema.parse(req.params.runId),
      ...body,
    }));
  } catch (error) { next(error); }
}

export async function latestMomentumPipelineRunsController(_req: Request, res: Response, next: NextFunction) {
  try { res.status(200).json(await getLatestMomentumPipelineRuns()); }
  catch (error) { next(error); }
}

export async function listMomentumPipelineRunsController(req: Request, res: Response, next: NextFunction) {
  try {
    const query = listMomentumPipelineRunsSchema.parse(req.query);
    res.status(200).json(await listMomentumPipelineRuns({
      page: query.page,
      pageSize: query.pageSize,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    }));
  }
  catch (error) { next(error); }
}

export async function getMomentumPipelineRunController(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await getMomentumPipelineRun(momentumPipelineRunIdSchema.parse(req.params.runId)));
  } catch (error) { next(error); }
}
