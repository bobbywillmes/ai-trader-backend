import crypto from 'node:crypto';
import type { EntryDecision, Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import {
  entryDecisionSchema,
  type EntryDecisionInput,
} from '../validators/entry-decision.schema.js';

type PersistedEntryDecisionPersistenceReason = NonNullable<
  EntryDecisionInput['persistenceReason']
>;

type EntryDecisionPersistenceReason =
  | 'duplicate_decision_key'
  | PersistedEntryDecisionPersistenceReason;

export type RecordEntryDecisionResult =
  | {
      persisted: true;
      skipped: false;
      duplicate: false;
      persistenceReason: Exclude<
        EntryDecisionPersistenceReason,
        'duplicate_decision_key'
      >;
      decision: EntryDecision;
    }
  | {
      persisted: false;
      skipped: true;
      duplicate: false;
      persistenceReason: null;
      decision: null;
    }
  | {
      persisted: false;
      skipped: false;
      duplicate: true;
      persistenceReason: 'duplicate_decision_key';
      decision: EntryDecision;
    };

const CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

function nullable<T>(value: T | null | undefined) {
  return value ?? null;
}

function toIso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function getDipThresholdBand(input: {
  dipPercent?: number | null | undefined;
  dipThresholdPercent?: number | null | undefined;
}) {
  if (
    input.dipPercent === null ||
    input.dipPercent === undefined ||
    input.dipThresholdPercent === null ||
    input.dipThresholdPercent === undefined
  ) {
    return null;
  }

  const distanceToThreshold = input.dipPercent - input.dipThresholdPercent;

  if (distanceToThreshold >= 0) return 'at_or_below_threshold';
  if (distanceToThreshold >= -0.25) return 'near_threshold';
  if (distanceToThreshold >= -1) return 'watch_band';

  return 'outside_watch_band';
}

function buildDecisionFingerprint(input: EntryDecisionInput) {
  const fingerprintInput = {
    symbol: input.symbol,
    decisionState: input.decisionState,
    decisionReason: nullable(input.decisionReason),
    signalAction: nullable(input.signalAction),
    signalEligible: nullable(input.signalEligible),
    signalCreated: input.signalCreated,
    signalBlocked: input.signalBlocked,
    blockingReason: nullable(input.blockingReason),
    dipThresholdBand: getDipThresholdBand(input),
    cooldownActive: nullable(input.cooldownActive),
    allowOrderSignals: nullable(input.allowOrderSignals),
    eventRisk: nullable(input.eventRisk),
    marketSession: nullable(input.marketSession),
    tradingEnabled: nullable(input.tradingEnabled),
    killSwitchEnabled: nullable(input.killSwitchEnabled),
    paperMode: nullable(input.paperMode),
    subscriptionId: nullable(input.subscriptionId),
    subscriptionKey: nullable(input.subscriptionKey),
    strategyId: nullable(input.strategyId),
    strategyKey: nullable(input.strategyKey),
    exitProfileId: nullable(input.exitProfileId),
    exitProfileKey: nullable(input.exitProfileKey),
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(fingerprintInput))
    .digest('hex');
}

function latestDecisionWhere(input: EntryDecisionInput): Prisma.EntryDecisionWhereInput {
  const where: Prisma.EntryDecisionWhereInput = {
    symbol: input.symbol,
  };

  if (input.subscriptionId !== null && input.subscriptionId !== undefined) {
    where.subscriptionId = input.subscriptionId;
  } else if (input.subscriptionKey) {
    where.subscriptionKey = input.subscriptionKey;
  }

  return where;
}

function getPersistenceReason(args: {
  input: EntryDecisionInput;
  decisionFingerprint: string;
  previous: EntryDecision | null;
}): PersistedEntryDecisionPersistenceReason | null {
  const { input, previous } = args;

  if (input.signalCreated) return 'signal_created';
  if (input.signalBlocked) return 'signal_blocked';
  if (!previous) return 'initial_state';
  if (previous.decisionState !== input.decisionState) {
    return 'decision_state_changed';
  }
  if ((previous.decisionReason ?? null) !== (input.decisionReason ?? null)) {
    return 'decision_reason_changed';
  }
  if (
    getDipThresholdBand(previous) !== getDipThresholdBand(input)
  ) {
    return 'dip_threshold_band_changed';
  }
  if ((previous.cooldownActive ?? null) !== (input.cooldownActive ?? null)) {
    return 'cooldown_state_changed';
  }
  if (
    (previous.allowOrderSignals ?? null) !==
    (input.allowOrderSignals ?? null)
  ) {
    return 'allow_order_signals_changed';
  }
  if ((previous.eventRisk ?? null) !== (input.eventRisk ?? null)) {
    return 'event_risk_changed';
  }
  if (
    previous.evaluatedAt.getTime() <=
    input.evaluatedAt.getTime() - CHECKPOINT_INTERVAL_MS
  ) {
    return 'periodic_checkpoint';
  }
  if (previous.decisionFingerprint !== args.decisionFingerprint) {
    return 'decision_state_changed';
  }

  return null;
}

function inputAsJson(input: EntryDecisionInput): Prisma.InputJsonValue {
  return {
    ...input,
    evaluatedAt: input.evaluatedAt.toISOString(),
    cooldownUntil: toIso(input.cooldownUntil),
  } as Prisma.InputJsonValue;
}

async function resolveDecisionContext(input: EntryDecisionInput) {
  const [subscription, security] = await Promise.all([
    input.subscriptionKey
      ? prisma.subscription.findUnique({
          where: { key: input.subscriptionKey },
          include: {
            strategy: true,
            exitProfile: true,
            security: true,
          },
        })
      : Promise.resolve(null),
    input.securityId === null || input.securityId === undefined
      ? prisma.security.findUnique({
          where: { symbol: input.symbol },
        })
      : Promise.resolve(null),
  ]);

  return {
    securityId:
      input.securityId ??
      subscription?.securityId ??
      subscription?.security.id ??
      security?.id ??
      null,
    subscriptionId: input.subscriptionId ?? subscription?.id ?? null,
    subscriptionKey: input.subscriptionKey ?? subscription?.key ?? null,
    strategyId: input.strategyId ?? subscription?.strategyId ?? null,
    strategyKey: input.strategyKey ?? subscription?.strategy.key ?? null,
    exitProfileId: input.exitProfileId ?? subscription?.exitProfileId ?? null,
    exitProfileKey:
      input.exitProfileKey ?? subscription?.exitProfile.key ?? null,
  };
}

export async function recordEntryDecision(
  rawInput: unknown
): Promise<RecordEntryDecisionResult> {
  const input = entryDecisionSchema.parse(rawInput);
  const existing = await prisma.entryDecision.findUnique({
    where: { decisionKey: input.decisionKey },
  });

  if (existing) {
    return {
      persisted: false,
      skipped: false,
      duplicate: true,
      persistenceReason: 'duplicate_decision_key',
      decision: existing,
    };
  }

  const [previous, context] = await Promise.all([
    prisma.entryDecision.findFirst({
      where: latestDecisionWhere(input),
      orderBy: {
        evaluatedAt: 'desc',
      },
    }),
    resolveDecisionContext(input),
  ]);
  const decisionFingerprint =
    input.decisionFingerprint ?? buildDecisionFingerprint(input);
  const persistenceReason =
    input.persistenceReason ??
    getPersistenceReason({
      input,
      decisionFingerprint,
      previous,
    });

  if (!persistenceReason) {
    return {
      persisted: false,
      skipped: true,
      duplicate: false,
      persistenceReason: null,
      decision: null,
    };
  }

  const decision = await prisma.entryDecision.create({
    data: {
      decisionKey: input.decisionKey,
      evaluatedAt: input.evaluatedAt,
      source: input.source,
      symbol: input.symbol,
      decisionState: input.decisionState,
      decisionReason: nullable(input.decisionReason),
      signalAction: nullable(input.signalAction),
      signalEligible: nullable(input.signalEligible),
      signalCreated: input.signalCreated,
      signalBlocked: input.signalBlocked,
      blockingReason: nullable(input.blockingReason),
      currentPrice: nullable(input.currentPrice),
      previousClose: nullable(input.previousClose),
      dayLow: nullable(input.dayLow),
      dayChangePercent: nullable(input.dayChangePercent),
      dipPercent: nullable(input.dipPercent),
      dipThresholdPercent: nullable(input.dipThresholdPercent),
      retraceFraction: nullable(input.retraceFraction),
      cooldownActive: nullable(input.cooldownActive),
      cooldownUntil: nullable(input.cooldownUntil),
      minutesSinceLastSignal: nullable(input.minutesSinceLastSignal),
      allowOrderSignals: nullable(input.allowOrderSignals),
      dryRun: nullable(input.dryRun),
      eventRisk: nullable(input.eventRisk),
      marketSession: nullable(input.marketSession),
      tradingEnabled: nullable(input.tradingEnabled),
      killSwitchEnabled: nullable(input.killSwitchEnabled),
      paperMode: nullable(input.paperMode),
      persistenceReason,
      decisionFingerprint,
      marketSnapshotJson: nullable(input.marketSnapshotJson) as
        | Prisma.InputJsonValue
        | typeof Prisma.JsonNull,
      runtimeSnapshotJson: nullable(input.runtimeSnapshotJson) as
        | Prisma.InputJsonValue
        | typeof Prisma.JsonNull,
      strategySnapshotJson: nullable(input.strategySnapshotJson) as
        | Prisma.InputJsonValue
        | typeof Prisma.JsonNull,
      indicatorSnapshotJson: nullable(input.indicatorSnapshotJson) as
        | Prisma.InputJsonValue
        | typeof Prisma.JsonNull,
      rawDecisionJson: (input.rawDecisionJson ?? inputAsJson(input)) as
        Prisma.InputJsonValue,
      securityId: context.securityId,
      subscriptionId: context.subscriptionId,
      subscriptionKey: context.subscriptionKey,
      strategyId: context.strategyId,
      strategyKey: context.strategyKey,
      exitProfileId: context.exitProfileId,
      exitProfileKey: context.exitProfileKey,
    },
  });

  return {
    persisted: true,
    skipped: false,
    duplicate: false,
    persistenceReason,
    decision,
  };
}

export async function ensureEntryDecisionCanLink(decisionKey: string) {
  const decision = await prisma.entryDecision.findUnique({
    where: { decisionKey },
    select: {
      id: true,
      decisionKey: true,
      orderIntentId: true,
    },
  });

  if (!decision) {
    throw new HttpError(
      404,
      `Entry decision ${decisionKey} was not found.`
    );
  }

  if (decision.orderIntentId !== null) {
    throw new HttpError(
      409,
      `Entry decision ${decisionKey} is already linked to order intent ${decision.orderIntentId}.`,
      {
        decisionKey,
        orderIntentId: decision.orderIntentId,
      }
    );
  }

  return decision;
}

export async function linkEntryDecisionToOrderIntent(args: {
  decisionKey: string;
  orderIntentId: number;
}) {
  const linked = await prisma.entryDecision.updateMany({
    where: {
      decisionKey: args.decisionKey,
      orderIntentId: null,
    },
    data: {
      orderIntentId: args.orderIntentId,
    },
  });

  if (linked.count === 1) {
    return prisma.entryDecision.findUnique({
      where: { decisionKey: args.decisionKey },
    });
  }

  const existing = await prisma.entryDecision.findUnique({
    where: { decisionKey: args.decisionKey },
    select: {
      orderIntentId: true,
    },
  });

  if (!existing) {
    throw new HttpError(
      404,
      `Entry decision ${args.decisionKey} was not found.`
    );
  }

  if (existing.orderIntentId === args.orderIntentId) {
    return prisma.entryDecision.findUnique({
      where: { decisionKey: args.decisionKey },
    });
  }

  throw new HttpError(
    409,
    `Entry decision ${args.decisionKey} is already linked to order intent ${existing.orderIntentId}.`,
    {
      decisionKey: args.decisionKey,
      orderIntentId: existing.orderIntentId,
    }
  );
}

export async function linkEntryDecisionToBrokerOrder(args: {
  orderIntentId: number;
  brokerOrderRecordId: number;
}) {
  return prisma.entryDecision.updateMany({
    where: {
      orderIntentId: args.orderIntentId,
      brokerOrderRecordId: null,
    },
    data: {
      brokerOrderRecordId: args.brokerOrderRecordId,
    },
  });
}

export async function linkEntryDecisionToTrackedPosition(args: {
  orderIntentId: number;
  trackedPositionId: number;
}) {
  return prisma.entryDecision.updateMany({
    where: {
      orderIntentId: args.orderIntentId,
      trackedPositionId: null,
    },
    data: {
      trackedPositionId: args.trackedPositionId,
    },
  });
}
