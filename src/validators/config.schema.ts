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
