import { z } from 'zod';

export const placeOrderSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .min(1)
      .transform((value) => value.toUpperCase()),
    side: z.enum(['buy', 'sell']),
    orderType: z.enum(['market', 'limit']),
    timeInForce: z.enum(['day', 'gtc']).default('day'),
    qty: z.coerce.number().positive().optional(),
    notional: z.coerce.number().positive().optional(),
    limitPrice: z.coerce.number().positive().optional(),
    extendedHours: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    const hasQty = data.qty !== undefined;
    const hasNotional = data.notional !== undefined;

    if (!hasQty && !hasNotional) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either qty or notional is required.',
        path: ['qty']
      });
    }

    if (hasQty && hasNotional) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide qty or notional, not both.',
        path: ['qty']
      });
    }

    if (data.orderType === 'limit' && data.limitPrice === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'limitPrice is required for limit orders.',
        path: ['limitPrice']
      });
    }

    if (data.orderType === 'market' && data.limitPrice !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'limitPrice is not allowed for market orders.',
        path: ['limitPrice']
      });
    }

    if (data.notional !== undefined && data.timeInForce !== 'day') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'notional orders are only allowed with day in this backend.',
        path: ['timeInForce']
      });
    }

    if (data.extendedHours && !(data.orderType === 'limit' && data.timeInForce === 'day')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'extendedHours requires a day limit order.',
        path: ['extendedHours']
      });
    }
  });

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;