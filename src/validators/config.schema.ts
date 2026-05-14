import { z } from 'zod';

const nullableNonnegativeNumber = z.coerce.number().nonnegative().nullable().optional();

export const updateRuntimeSettingsSchema = z
  .object({
    tradingEnabled: z.boolean().optional(),
    paperMode: z.boolean().optional(),
    killSwitchEnabled: z.boolean().optional(),

    maxDailyEntryOrders: nullableNonnegativeNumber,
    maxDailyEntryNotional: nullableNonnegativeNumber,
    maxOpenPositions: nullableNonnegativeNumber,
    maxTotalOpenNotional: nullableNonnegativeNumber,
    maxSymbolOpenNotional: nullableNonnegativeNumber,
    maxSubscriptionOpenNotional: nullableNonnegativeNumber,
  })
  .refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    {
      message: 'At least one setting is required.',
    }
  );