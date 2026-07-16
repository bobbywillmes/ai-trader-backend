import {
  MomentumPipelineRunSource,
  MomentumPipelineRunStatus,
  MomentumPipelineStage,
} from '@prisma/client';
import { z } from 'zod';

export const startMomentumPipelineRunSchema = z.object({
  source: z.nativeEnum(MomentumPipelineRunSource),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const momentumPipelineRunIdSchema = z.string().trim().min(1).max(100);
export const momentumPipelineStageSchema = z.nativeEnum(MomentumPipelineStage);
export const recordMomentumPipelineStageSchema = z.object({
  status: z.enum(['SUCCEEDED', 'FAILED']),
  result: z.unknown().optional(),
});
export const completeMomentumPipelineRunSchema = z.object({
  status: z.enum(['SUCCEEDED', 'PARTIAL']).optional(),
});
export const failMomentumPipelineRunSchema = z.object({
  stage: z.nativeEnum(MomentumPipelineStage),
  errorCode: z.string().trim().min(1).max(100),
  errorMessage: z.string().trim().min(1).max(2_000),
});
export const listMomentumPipelineRunsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  status: z.nativeEnum(MomentumPipelineRunStatus).optional(),
  source: z.nativeEnum(MomentumPipelineRunSource).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: 'from must be before or equal to to.',
  path: ['from'],
});
