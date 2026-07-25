import { z } from 'zod';

const signalMetadataSchema = z.object({
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
  decisionKey: z.string().trim().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const entrySignalSchema = signalMetadataSchema;

export const assignmentEntrySignalSchema = signalMetadataSchema
  .omit({ subscriptionKey: true })
  .extend({
    tradingAccountSubscriptionId: z.coerce.number().int().positive(),
  })
  .strict();

export type EntrySignalInput = z.infer<typeof entrySignalSchema>;
export type AssignmentEntrySignalInput = z.infer<
  typeof assignmentEntrySignalSchema
>;
