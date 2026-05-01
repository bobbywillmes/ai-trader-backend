import { z } from 'zod';

export const entrySignalSchema = z.object({
  subscriptionKey: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.toLowerCase()),

  signalType: z.literal('entry').default('entry'),

  source: z.string().trim().min(1).default('n8n-ai-trader'),

  reason: z.string().trim().min(1).optional(),
  score: z.coerce.number().min(0).max(100).optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),

  runId: z.string().trim().min(1).optional(),
  batchId: z.string().trim().min(1).optional(),

  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type EntrySignalInput = z.infer<typeof entrySignalSchema>;