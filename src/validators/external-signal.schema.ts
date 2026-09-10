import { z } from 'zod';
import { ExternalSignalProvider, SignalDeliveryRejectionCode, SignalDeliveryStatus, SignalEvent } from '@prisma/client';

export const externalSignalIdSchema = z.coerce.number().int().positive().max(2147483647);
const identity = z.string().trim().min(1).max(200);
// Creation only: historical binding keys and webhook lookup retain their identity.
export const newExternalStrategyKeySchema = z.string()
  .transform(value => value.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-'))
  .pipe(z.string().min(1).max(200).regex(/^[a-z0-9_-]+$/,
    'Use only lowercase letters, digits, hyphens, and underscores.'));
export const createExternalSignalSourceSchema = z.object({
  name: identity,
  provider: z.enum(ExternalSignalProvider),
  enabled: z.boolean().optional(),
}).strict();
export const updateExternalSignalSourceSchema = z.object({
  name: identity.optional(), enabled: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
export const createStrategySignalBindingSchema = z.object({
  signalSourceId: externalSignalIdSchema,
  strategyId: externalSignalIdSchema,
  externalStrategyKey: newExternalStrategyKeySchema,
  enabled: z.boolean().optional(),
}).strict();
export const updateStrategySignalBindingSchema = z.object({
  enabled: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
export const prepareStrategySignalRevisionSchema = z.object({
  changeNote: z.string().trim().min(1).max(500).optional(),
}).strict();
export const strategySignalRevisionActionSchema = z.object({}).strict();

// Offset-bearing ISO timestamps, millisecond precision, and valid calendar dates.
export const signalTimestampSchema = z.iso.datetime({ offset: true })
  .refine(value => !/\.\d{4,}/.test(value), 'At most millisecond precision is supported.')
  .refine(value => Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0,
    'Timestamp must be at or after the Unix epoch.');

export const externalSignalListSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  signalSourceId: externalSignalIdSchema.optional(),
  strategyId: externalSignalIdSchema.optional(),
  securityId: externalSignalIdSchema.optional(),
  signalId: externalSignalIdSchema.optional(),
  symbol: z.string().trim().min(1).max(32).transform(value => value.toUpperCase()).optional(),
  event: z.enum(SignalEvent).optional(),
  status: z.enum(SignalDeliveryStatus).optional(),
  rejectionCode: z.enum(SignalDeliveryRejectionCode).optional(),
  timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']).optional(),
  from: signalTimestampSchema.optional(),
  to: signalTimestampSchema.optional(),
}).strict().refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to),
  'from must be before or equal to to.');

export type ExternalSignalListFilters = z.infer<typeof externalSignalListSchema>;

export const externalSignalEnvelopeSchema = z.object({
  externalStrategyKey: identity,
  strategyRevision: z.number().int().positive().max(2147483647),
  event: z.enum(SignalEvent),
  symbol: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9.\-/^]+$/).transform(value => value.toUpperCase()),
  timeframe: z.string().trim().min(1).max(32),
  signalTime: signalTimestampSchema,
  barTime: signalTimestampSchema.optional(),
  metadata: z.record(z.string(), z.json()).optional()
    .refine(value => value === undefined || Buffer.byteLength(JSON.stringify(value)) <= 4096,
      'Metadata exceeds 4096 bytes.'),
}).strict();
