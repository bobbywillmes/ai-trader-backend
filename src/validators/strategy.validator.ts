import { z } from 'zod';

export const strategyDetailQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type StrategyDetailQuery = z.infer<typeof strategyDetailQuerySchema>;
