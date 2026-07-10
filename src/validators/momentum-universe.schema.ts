import { MomentumUniverseReason } from '@prisma/client';
import { z } from 'zod';

const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

export const listMomentumUniverseSchema = z.object({
  enabled: booleanQuery.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(250).default(50),
});

const universeFields = {
  enabled: z.boolean().optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  newsEnabled: z.boolean().optional(),
  priceScanningEnabled: z.boolean().optional(),
  pullIntervalMin: z.number().int().min(1).max(1440).optional(),
  addedReason: z.nativeEnum(MomentumUniverseReason).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
};

export const createMomentumUniverseMemberSchema = z.object({
  securityId: z.number().int().positive(),
  ...universeFields,
});

export const updateMomentumUniverseMemberSchema = z
  .object(universeFields)
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one universe member field is required.',
  });

export const momentumUniverseMemberIdSchema = z.string().trim().min(1).max(100);

export type ListMomentumUniverseInput = z.infer<typeof listMomentumUniverseSchema>;
export type CreateMomentumUniverseMemberInput = z.infer<
  typeof createMomentumUniverseMemberSchema
>;
export type UpdateMomentumUniverseMemberInput = z.infer<
  typeof updateMomentumUniverseMemberSchema
>;
