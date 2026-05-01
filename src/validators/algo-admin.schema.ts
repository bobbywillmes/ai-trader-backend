import { z } from 'zod';

const keySchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toLowerCase());

const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toUpperCase());

const nullablePositiveNumber = z.coerce.number().positive().nullable().optional();

const nullableNonNegativeNumber = z.coerce.number().nonnegative().nullable().optional();

const nullablePositiveInt = z.coerce.number().int().positive().nullable().optional();

export const createSubscriptionSchema = z
  .object({
    key: keySchema,
    name: z.string().trim().min(1),
    symbol: symbolSchema,

    broker: z.string().trim().min(1).default('alpaca'),
    brokerMode: z.string().trim().min(1).default('paper'),

    sizingType: z.enum(['fixed_qty', 'dollar_amount']),
    sizingValue: z.coerce.number().positive(),

    strategyId: z.coerce.number().int().positive().optional(),
    strategyKey: keySchema.optional(),

    exitProfileId: z.coerce.number().int().positive().optional(),
    exitProfileKey: keySchema.optional(),

    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.strategyId && !data.strategyKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'strategyId or strategyKey is required.',
        path: ['strategyId'],
      });
    }

    if (data.strategyId && data.strategyKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide strategyId or strategyKey, not both.',
        path: ['strategyId'],
      });
    }

    if (!data.exitProfileId && !data.exitProfileKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exitProfileId or exitProfileKey is required.',
        path: ['exitProfileId'],
      });
    }

    if (data.exitProfileId && data.exitProfileKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exitProfileId or exitProfileKey, not both.',
        path: ['exitProfileId'],
      });
    }
  });

export const updateSubscriptionSchema = z
  .object({
    key: keySchema.optional(),
    name: z.string().trim().min(1).optional(),
    symbol: symbolSchema.optional(),

    broker: z.string().trim().min(1).optional(),
    brokerMode: z.string().trim().min(1).optional(),

    sizingType: z.enum(['fixed_qty', 'dollar_amount']).optional(),
    sizingValue: z.coerce.number().positive().optional(),

    strategyId: z.coerce.number().int().positive().optional(),
    strategyKey: keySchema.optional(),

    exitProfileId: z.coerce.number().int().positive().optional(),
    exitProfileKey: keySchema.optional(),

    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.strategyId && data.strategyKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide strategyId or strategyKey, not both.',
        path: ['strategyId'],
      });
    }

    if (data.exitProfileId && data.exitProfileKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exitProfileId or exitProfileKey, not both.',
        path: ['exitProfileId'],
      });
    }
  });

export const createExitProfileSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1),
  description: z.string().trim().nullable().optional(),

  targetPct: nullablePositiveNumber,
  stopLossPct: nullablePositiveNumber,
  trailingStopPct: nullableNonNegativeNumber,
  maxHoldDays: nullablePositiveInt,

  exitMode: z.string().trim().min(1),
  takeProfitBehavior: z.string().trim().min(1),

  enabled: z.boolean().optional(),
});

export const updateExitProfileSchema = z.object({
  key: keySchema.optional(),
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),

  targetPct: nullablePositiveNumber,
  stopLossPct: nullablePositiveNumber,
  trailingStopPct: nullableNonNegativeNumber,
  maxHoldDays: nullablePositiveInt,

  exitMode: z.string().trim().min(1).optional(),
  takeProfitBehavior: z.string().trim().min(1).optional(),

  enabled: z.boolean().optional(),
});

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;

export type CreateExitProfileInput = z.infer<typeof createExitProfileSchema>;
export type UpdateExitProfileInput = z.infer<typeof updateExitProfileSchema>;