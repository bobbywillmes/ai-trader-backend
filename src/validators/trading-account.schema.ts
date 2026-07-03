import {
  BrokerCredentialAuthType,
  PositionSizingType,
  TradingAccountStatus,
} from '@prisma/client';
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

const nullablePositiveNumber = z.coerce.number().positive().nullable().optional();
const nullablePositiveInteger = z.coerce.number().int().positive().nullable().optional();

export const updateTradingAccountRiskSettingsSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    maxDailyEntryOrders: nullablePositiveInteger,
    maxDailyEntryNotional: nullablePositiveNumber,
    maxOpenPositions: nullablePositiveInteger,
    maxTotalOpenNotional: nullablePositiveNumber,
    maxSymbolOpenNotional: nullablePositiveNumber,
    maxSubscriptionOpenNotional: nullablePositiveNumber,
    notes: z.string().trim().nullable().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one trading account risk settings field is required.',
  });

export type UpdateTradingAccountRiskSettingsInput = z.infer<
  typeof updateTradingAccountRiskSettingsSchema
>;

export const entryRiskPreviewSchema = z.strictObject({
  subscriptionKey: z.string().trim().min(1),
  ignoreSession: z.boolean().optional(),
});

export type EntryRiskPreviewInput = z.infer<typeof entryRiskPreviewSchema>;

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

const accountSubscriptionBaseSchema = {
  allocationId: z.coerce.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  entriesEnabled: z.boolean().optional(),
  exitsEnabled: z.boolean().optional(),
  sizingType: z.enum(PositionSizingType).optional(),
  fixedQty: z.coerce.number().positive().nullable().optional(),
  maxPositionNotional: z.coerce.number().positive().nullable().optional(),
  minPositionNotional: z.coerce.number().nonnegative().nullable().optional(),
  maxQty: z.coerce.number().positive().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
} as const;

function validateCreateAccountSubscriptionSizing(
  data: {
    sizingType?: PositionSizingType | undefined;
    fixedQty?: number | null | undefined;
    maxPositionNotional?: number | null | undefined;
  },
  ctx: z.RefinementCtx
) {
  const sizingType = data.sizingType ?? PositionSizingType.FIXED_QTY;

  if (sizingType === PositionSizingType.FIXED_QTY && data.fixedQty == null) {
    ctx.addIssue({
      code: 'custom',
      path: ['fixedQty'],
      message: 'fixedQty is required when sizingType is FIXED_QTY.',
    });
  }

  if (
    sizingType === PositionSizingType.MAX_NOTIONAL &&
    data.maxPositionNotional == null
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxPositionNotional'],
      message:
        'maxPositionNotional is required when sizingType is MAX_NOTIONAL.',
    });
  }
}

export const createTradingAccountSubscriptionSchema = z
  .strictObject({
    subscriptionId: z.coerce.number().int().positive(),
    ...accountSubscriptionBaseSchema,
  })
  .superRefine(validateCreateAccountSubscriptionSizing);

export type CreateTradingAccountSubscriptionInput = z.infer<
  typeof createTradingAccountSubscriptionSchema
>;

export const updateTradingAccountSubscriptionSchema = z
  .strictObject(accountSubscriptionBaseSchema)
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one trading account subscription field is required.',
  });

export type UpdateTradingAccountSubscriptionInput = z.infer<
  typeof updateTradingAccountSubscriptionSchema
>;
