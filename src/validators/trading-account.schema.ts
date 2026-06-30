import { BrokerCredentialAuthType, TradingAccountStatus } from '@prisma/client';
import { z } from 'zod';

const allocationKeySchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(
    z
      .string()
      .min(1)
      .regex(/^[a-z0-9_-]+$/, {
        message: 'Allocation key may only contain letters, numbers, hyphens, and underscores.',
      })
  );

export const updateTradingAccountSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).optional(),
    estimatedTradingCapital: z.coerce.number().nonnegative().nullable().optional(),
    status: z.enum(TradingAccountStatus).optional(),
    tradingEnabled: z.boolean().optional(),
    killSwitchEnabled: z.boolean().optional(),
    pausedReason: z.string().trim().nullable().optional(),
    notes: z.string().trim().nullable().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one trading account field is required.',
  });

export type UpdateTradingAccountInput = z.infer<
  typeof updateTradingAccountSchema
>;

export const upsertTradingAccountCredentialSchema = z.strictObject({
  authType: z.literal(BrokerCredentialAuthType.API_KEY).default(
    BrokerCredentialAuthType.API_KEY
  ),
  apiKey: z.string().trim().min(1),
  apiSecret: z.string().trim().min(1),
});

export type UpsertTradingAccountCredentialInput = z.infer<
  typeof upsertTradingAccountCredentialSchema
>;

export const createTradingAccountAllocationSchema = z.strictObject({
  key: allocationKeySchema,
  name: z.string().trim().min(1),
  description: z.string().trim().nullable().optional(),
  enabled: z.boolean().optional(),
  maxAllocatedNotional: z.coerce.number().positive().nullable().optional(),
  maxOpenPositions: z.coerce.number().int().positive().nullable().optional(),
  maxPositionNotional: z.coerce.number().positive().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
});

export type CreateTradingAccountAllocationInput = z.infer<
  typeof createTradingAccountAllocationSchema
>;

export const updateTradingAccountAllocationSchema = z
  .strictObject({
    key: allocationKeySchema.optional(),
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().nullable().optional(),
    enabled: z.boolean().optional(),
    maxAllocatedNotional: z.coerce.number().positive().nullable().optional(),
    maxOpenPositions: z.coerce.number().int().positive().nullable().optional(),
    maxPositionNotional: z.coerce.number().positive().nullable().optional(),
    notes: z.string().trim().nullable().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one trading account allocation field is required.',
  });

export type UpdateTradingAccountAllocationInput = z.infer<
  typeof updateTradingAccountAllocationSchema
>;
