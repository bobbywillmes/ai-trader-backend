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

const strategyMarketPolicyRuleSchema = z.object({
  dimension: z.enum(['TREND', 'VOLATILITY', 'BREADTH', 'PARTICIPATION', 'INTRADAY_STRESS']),
  algorithmVersion: z.string().trim().min(1).max(80),
  requirement: z.enum(['REQUIRED', 'IGNORED']),
  allowedStates: z.array(z.string().trim().min(1).max(40)).max(20),
}).strict();

export const saveStrategyMarketPolicyRevisionSchema = z.object({
  expectedConfigurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  rules: z.array(strategyMarketPolicyRuleSchema).length(5),
}).strict();

export const activateStrategyMarketPolicyRevisionSchema = z.object({
  expectedConfigurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
