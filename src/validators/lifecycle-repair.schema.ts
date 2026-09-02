import { z } from 'zod';

export const diagnosePositionAttributionRepairSchema = z.object({
  repairType: z.literal('RESOLVE_POSITION_ATTRIBUTION'),
  tradingAccountId: z.coerce.number().int().positive(),
  trackedPositionId: z.coerce.number().int().positive(),
}).strict();

export const applyLifecycleRepairSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  confirmation: z.literal('APPLY POSITION ATTRIBUTION REPAIR'),
  attemptKey: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

export const previewHistoricalEntryLifecycleSchema = z.object({
  attentionId: z.coerce.number().int().positive(),
}).strict();

export const decideLifecycleRepairActionSchema = z.object({
  expectedRevision: z.number().int().positive(),
  decision: z.enum(['APPROVE', 'REFUSE']),
  reason: z.string().trim().min(1).max(1000),
}).strict();

export const applyLifecycleRepairActionSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
  confirmation: z.string().trim().min(1).max(160),
  attemptKey: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();
