import { z } from 'zod';

export const strategyDetailQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type StrategyDetailQuery = z.infer<typeof strategyDetailQuerySchema>;

export const updateStrategyEnabledSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export type UpdateStrategyEnabledInput = z.infer<
  typeof updateStrategyEnabledSchema
>;

export const strategyMarketPolicyNoteSchema = z.object({
  changeNote: z.string().trim().min(1).max(500).optional(),
}).strict();

export const strategyMarketPolicyRuleSchema = z.object({
  requirement: z.enum(['REQUIRED', 'IGNORED']),
  allowedStates: z.array(z.string().trim().min(1).max(40)).max(20),
}).strict();

export const strategyMarketPolicyDimensionSchema = z.enum([
  'TREND', 'VOLATILITY', 'BREADTH', 'PARTICIPATION', 'INTRADAY_STRESS',
]);
