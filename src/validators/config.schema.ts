import { z } from 'zod';

const nullableNonnegativeNumber = z.coerce.number().nonnegative().nullable().optional();
const entrySessionMinutes = z.number().int().min(0).max(390);

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

    entrySessionGuardEnabled: z.boolean().optional(),
    entryStartMinutesAfterOpen: entrySessionMinutes.optional(),
    entryCutoffMinutesBeforeClose: entrySessionMinutes.nullable().optional(),
    failClosedOnMarketClockError: z.boolean().optional(),

    reconciliationWorkerEnabled: z.boolean().optional(),
    reconciliationWorkerIntervalMinutes: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .optional(),
  
  })
  .refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    {
      message: 'At least one setting is required.',
    }
  )
  .refine(
    (data) => {
      if (
        data.entryStartMinutesAfterOpen === undefined ||
        data.entryCutoffMinutesBeforeClose === undefined ||
        data.entryCutoffMinutesBeforeClose === null
      ) {
        return true;
      }

      return (
        data.entryStartMinutesAfterOpen + data.entryCutoffMinutesBeforeClose < 390
      );
    },
    {
      message:
        'Opening and closing entry buffers must leave part of a normal 390-minute session available.',
      path: ['entryCutoffMinutesBeforeClose'],
    }
  );
