import { z } from 'zod';

const chartTimestamp = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const momentumMarketChartSymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9.-]+$/)
  .transform((value) => value.toUpperCase());

export const momentumMarketChartQuerySchema = z
  .object({
    interval: z.enum(['1m', '5m', '15m', '1d']).default('1m'),
    from: chartTimestamp.optional(),
    to: chartTimestamp.optional(),
    candidateId: z.string().trim().min(1).max(100).optional(),
  })
  .refine(
    (value) => !value.from || !value.to || value.from <= value.to,
    { message: 'from must be before or equal to to.', path: ['from'] }
  );

export type MomentumMarketChartQuery = z.infer<
  typeof momentumMarketChartQuerySchema
>;
