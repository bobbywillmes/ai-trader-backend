import { z } from 'zod';

export const createLiveEntryAcceptanceRunSchema = z.strictObject({
  tradingAccountSubscriptionId: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
});

export const executeLiveEntryAcceptanceRunSchema = z.strictObject({
  requestKey: z.string().trim().min(8).max(200),
  expectedPreviewRevision: z.coerce.number().int().positive(),
  expectedPreviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  typedConfirmation: z.string().trim().min(1).max(100),
});

export const abortLiveEntryAcceptanceRunSchema = z.strictObject({
  reason: z.string().trim().min(1).max(1_000),
});

