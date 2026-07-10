import {
  CatalystEventType,
  CatalystSentiment,
  CatalystSource,
  CatalystTier,
  MomentumCandidateState,
} from '@prisma/client';
import { z } from 'zod';

const optionalBooleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const paginationFields = {
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
};

const dateQuery = z.coerce.date();

export const momentumResearchCandidatesQuerySchema = z
  .object({
    ...paginationFields,
    search: z.string().trim().min(1).max(100).optional(),
    state: z.nativeEnum(MomentumCandidateState).optional(),
    minTotalScore: z.coerce.number().int().min(0).optional(),
    catalystType: z.nativeEnum(CatalystEventType).optional(),
    entryReady: optionalBooleanQuery,
    blocked: optionalBooleanQuery,
    from: dateQuery.optional(),
    to: dateQuery.optional(),
    sortBy: z
      .enum(['lastEvaluatedAt', 'updatedAt', 'discoveredAt', 'totalScore', 'symbol'])
      .default('lastEvaluatedAt'),
    sortDirection: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to, {
    message: 'from must be before or equal to to.',
    path: ['from'],
  })
  .refine(
    (value) => value.entryReady === undefined || value.blocked === undefined,
    {
      message: 'entryReady and blocked cannot be combined.',
      path: ['entryReady'],
    }
  );

export const momentumResearchCatalystsQuerySchema = z
  .object({
    ...paginationFields,
    search: z.string().trim().min(1).max(100).optional(),
    publisher: z.string().trim().min(1).max(200).optional(),
    source: z.nativeEnum(CatalystSource).optional(),
    catalystType: z.nativeEnum(CatalystEventType).optional(),
    tier: z.nativeEnum(CatalystTier).optional(),
    sentiment: z.nativeEnum(CatalystSentiment).optional(),
    from: dateQuery.optional(),
    to: dateQuery.optional(),
    sortBy: z.enum(['publishedAt', 'receivedAt', 'updatedAt']).default('publishedAt'),
    sortDirection: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to, {
    message: 'from must be before or equal to to.',
    path: ['from'],
  });

export const momentumResearchCandidateIdSchema = z.string().trim().min(1).max(100);
export const momentumResearchSymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .transform((value) => value.toUpperCase());

export type MomentumResearchCandidatesQuery = z.infer<
  typeof momentumResearchCandidatesQuerySchema
>;
export type MomentumResearchCatalystsQuery = z.infer<
  typeof momentumResearchCatalystsQuerySchema
>;
