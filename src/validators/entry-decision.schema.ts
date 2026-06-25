import { z } from 'zod';

const optionalString = z.string().trim().min(1).nullable().optional();
const optionalBoolean = z.boolean().nullable().optional();
const optionalNumber = z.coerce.number().finite().nullable().optional();
const optionalDate = z.coerce.date().nullable().optional();
const optionalPositiveInt = z.coerce.number().int().positive().nullable().optional();
const jsonObject = z.record(z.string(), z.unknown());

export const entryDecisionPersistenceReasonSchema = z.enum([
  'initial_state',
  'signal_created',
  'signal_blocked',
  'decision_state_changed',
  'decision_reason_changed',
  'dip_threshold_band_changed',
  'cooldown_state_changed',
  'allow_order_signals_changed',
  'event_risk_changed',
  'periodic_checkpoint',
]);

export const entryDecisionSchema = z.object({
  decisionKey: z.string().trim().min(1),
  evaluatedAt: z.coerce.date(),
  source: z.string().trim().min(1).default('n8n-ai-trader'),
  symbol: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.toUpperCase()),

  decisionState: z.string().trim().min(1),
  decisionReason: optionalString,

  signalAction: optionalString,
  signalEligible: optionalBoolean,
  signalCreated: z.boolean().default(false),
  signalBlocked: z.boolean().default(false),
  blockingReason: optionalString,

  currentPrice: optionalNumber,
  previousClose: optionalNumber,
  dayLow: optionalNumber,
  dayChangePercent: optionalNumber,
  dipPercent: optionalNumber,
  dipThresholdPercent: optionalNumber,
  retraceFraction: optionalNumber,

  cooldownActive: optionalBoolean,
  cooldownUntil: optionalDate,
  minutesSinceLastSignal: optionalNumber,
  allowOrderSignals: optionalBoolean,
  dryRun: optionalBoolean,
  eventRisk: optionalString,
  marketSession: optionalString,
  tradingEnabled: optionalBoolean,
  killSwitchEnabled: optionalBoolean,
  paperMode: optionalBoolean,

  persistenceReason: entryDecisionPersistenceReasonSchema.nullable().optional(),
  decisionFingerprint: optionalString,

  marketSnapshotJson: jsonObject.nullable().optional(),
  runtimeSnapshotJson: jsonObject.nullable().optional(),
  strategySnapshotJson: jsonObject.nullable().optional(),
  indicatorSnapshotJson: jsonObject.nullable().optional(),
  rawDecisionJson: jsonObject.nullable().optional(),

  securityId: optionalPositiveInt,
  subscriptionId: optionalPositiveInt,
  subscriptionKey: optionalString,
  strategyId: optionalPositiveInt,
  strategyKey: optionalString,
  exitProfileId: optionalPositiveInt,
  exitProfileKey: optionalString,
});

export type EntryDecisionInput = z.infer<typeof entryDecisionSchema>;
