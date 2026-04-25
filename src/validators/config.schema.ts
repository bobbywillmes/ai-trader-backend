import { z } from 'zod';

export const updateRuntimeSettingsSchema = z
  .object({
    tradingEnabled: z.boolean().optional(),
    paperMode: z.boolean().optional()
  })
  .refine(
    (data) =>
      data.tradingEnabled !== undefined || data.paperMode !== undefined,
    {
      message: 'At least one setting is required.'
    }
  );

export const allowedTickerBodySchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .transform((value) => value.toUpperCase())
});

export const allowedTickerParamsSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .transform((value) => value.toUpperCase())
});