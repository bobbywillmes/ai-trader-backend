import { MomentumPipelineRunSource } from '@prisma/client';
import { z } from 'zod';

export const fullMomentumPipelineSchema = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
  expirationLimit: z.number().int().positive().max(1_000).optional(),
  minCatalystScore: z.number().int().min(0).max(100).optional(),
  candidateTake: z.number().int().positive().max(250).optional(),
  expiresInHours: z.number().int().positive().max(168).optional(),
  maxCandidates: z.number().int().positive().max(100).optional(),
  minHandoffScore: z.number().int().min(0).max(100).optional(),
});

export const signalFullMomentumPipelineSchema = fullMomentumPipelineSchema.extend({
  source: z.enum([
    MomentumPipelineRunSource.N8N_SCHEDULED,
    MomentumPipelineRunSource.N8N_MANUAL,
  ]).default(MomentumPipelineRunSource.N8N_SCHEDULED),
});
