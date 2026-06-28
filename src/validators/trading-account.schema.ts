import { BrokerCredentialAuthType, TradingAccountStatus } from '@prisma/client';
import { z } from 'zod';

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
