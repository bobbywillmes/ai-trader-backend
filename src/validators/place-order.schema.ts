import { z } from 'zod';

export const placeOrderSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .min(1)
      .transform((value) => value.toUpperCase())
      .optional(),
    side: z.enum(['buy', 'sell']).optional(),
    orderType: z.enum(['market', 'limit']).optional(),
    timeInForce: z.enum(['day', 'gtc']).default('day').optional(),
    qty: z.coerce.number().positive().optional(),
    notional: z.coerce.number().positive().optional(),
    limitPrice: z.coerce.number().positive().optional(),
    extendedHours: z.boolean().default(false),
    subscriptionKey: z.string().trim().min(1).optional(),
    signalType: z.enum(['entry', 'exit']).default('entry').optional(),
    signalMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((data, ctx) => {
    const usingSubscription = !!data.subscriptionKey;

    if (!usingSubscription) {
      if (!data.symbol) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'symbol is required when not using subscriptionKey',
          path: ['symbol']
        });
      }

      if (!data.side) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'side is required when not using subscriptionKey',
          path: ['side']
        });
      }

      if (data.orderType === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'orderType is required when not using subscriptionKey',
          path: ['orderType']
        });
      }

      if (data.timeInForce === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'timeInForce is required when not using subscriptionKey',
          path: ['timeInForce']
        });
      }

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

export type ResolvedPlaceOrderInput = PlaceOrderInput & {
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  timeInForce: 'day' | 'gtc';
  subscriptionId?: number;
};