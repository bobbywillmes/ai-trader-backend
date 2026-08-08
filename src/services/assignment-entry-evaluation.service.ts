import type { Prisma } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type {
  PlaceOrderInput,
  ResolvedPlaceOrderInput,
} from '../validators/place-order.schema.js';
import {
  resolveRuntimeAccountSubscriptionSizing,
  type RuntimeAccountSubscriptionSizingResult,
} from './account-subscription-runtime-sizing.service.js';
import {
  evaluateOrderRisk,
  type RiskGateResult,
} from './risk-gate.service.js';
import { resolveSubscriptionOrderInput } from './subscription.service.js';

const ASSIGNMENT_ENTRY_CONTEXT_SELECT = {
  id: true,
  subscriptionId: true,
  allocationId: true,
  enabled: true,
  entriesEnabled: true,
  exitsEnabled: true,
  sizingType: true,
  fixedQty: true,
  maxPositionNotional: true,
  reservedNotional: true,
  minPositionNotional: true,
  maxQty: true,
  subscription: {
    select: {
      id: true,
      key: true,
      symbol: true,
      enabled: true,
      security: true,
      strategy: true,
      exitProfile: true,
    },
  },
  allocation: true,
  tradingAccount: {
    select: {
      id: true,
      displayName: true,
      broker: true,
      environment: true,
      status: true,
    },
  },
} satisfies Prisma.TradingAccountSubscriptionSelect;

export type AssignmentEntryContext =
  Prisma.TradingAccountSubscriptionGetPayload<{
    select: typeof ASSIGNMENT_ENTRY_CONTEXT_SELECT;
  }>;

export type AssignmentEntryEvaluation = {
  context: AssignmentEntryContext;
  input: ResolvedPlaceOrderInput;
  sizing: RuntimeAccountSubscriptionSizingResult;
  referencePrice: number | null;
  priceEvidence: {
    observedAt: string | null;
    source: string | null;
  };
  estimatedNotional: number | null;
  session: Prisma.InputJsonValue | null;
  risk: RiskGateResult;
  blockers: Array<{
    code: string;
    message: string;
    details: Prisma.InputJsonValue | null;
  }>;
  warnings: Array<{
    code: string;
    message: string;
  }>;
  permitsIntentCreation: boolean;
  outcomeCode:
    | 'ENTRY_ELIGIBLE'
    | 'ENTRY_RISK_BLOCKED'
    | 'LIVE_ENTRY_POLICY_BLOCKED';
};

function riskRule(result: RiskGateResult) {
  if (result.allowed || !result.details || typeof result.details !== 'object' || Array.isArray(result.details)) {
    return null;
  }

  const rule = (result.details as Record<string, unknown>).rule;
  return typeof rule === 'string' ? rule : null;
}

function getLiveEntryPolicyBlock(context: AssignmentEntryContext) {
  if (context.tradingAccount.environment !== 'LIVE') return null;

  if (!env.ALLOW_LIVE_TRADING || !env.ALLOW_LIVE_RISK_REDUCING_WRITES) {
    return {
      allowed: false as const,
      statusCode: 403,
      reason: `LIVE entry writes are blocked for TradingAccount ${context.tradingAccount.id}: ALLOW_LIVE_TRADING and ALLOW_LIVE_RISK_REDUCING_WRITES must be true.`,
      details: {
        code: 'live_entry_policy_blocked',
        rule: 'live_entry_policy_blocked',
        tradingAccountId: context.tradingAccount.id,
        allowLiveTrading: env.ALLOW_LIVE_TRADING,
        allowLiveRiskReducingWrites: env.ALLOW_LIVE_RISK_REDUCING_WRITES,
      } as Prisma.InputJsonValue,
    };
  }

  return null;
}

export async function resolveAssignmentEntryContext(
  input: PlaceOrderInput
): Promise<{
  context: AssignmentEntryContext;
  input: ResolvedPlaceOrderInput;
}> {
  const resolvedInput = await resolveSubscriptionOrderInput(input);
  const tradingAccountId = resolvedInput.tradingAccountId;
  const tradingAccountSubscriptionId =
    resolvedInput.tradingAccountSubscriptionId;

  if (tradingAccountId === undefined || tradingAccountSubscriptionId === undefined) {
    throw new HttpError(400, 'Resolved entry is missing account assignment identity.');
  }

  const context = await prisma.tradingAccountSubscription.findUniqueOrThrow({
    where: { id: tradingAccountSubscriptionId },
    select: ASSIGNMENT_ENTRY_CONTEXT_SELECT,
  });

  return { context, input: resolvedInput };
}

export async function calculateAssignmentEntrySizing(args: {
  context: AssignmentEntryContext;
  input: ResolvedPlaceOrderInput;
}) {
  const subscriptionId = args.input.subscriptionId;
  if (subscriptionId === undefined) {
    throw new HttpError(400, 'Resolved entry is missing subscriptionId.');
  }

  const sizing = await resolveRuntimeAccountSubscriptionSizing({
    tradingAccountSubscriptionId: args.context.id,
    tradingAccountId: args.context.tradingAccount.id,
    subscriptionId,
    symbol: args.input.symbol,
  });
  const { notional: _legacyNotional, ...inputWithoutNotional } = args.input;

  return {
    sizing,
    input: {
      ...inputWithoutNotional,
      qty: sizing.qty,
    } satisfies ResolvedPlaceOrderInput,
  };
}

export async function evaluateResolvedAssignmentEntry(args: {
  context: AssignmentEntryContext;
  input: ResolvedPlaceOrderInput;
  sizing: RuntimeAccountSubscriptionSizingResult;
  enforceEntrySessionGuard?: boolean;
  excludeOrderIntentId?: number;
}): Promise<AssignmentEntryEvaluation> {
  const livePolicyBlock = getLiveEntryPolicyBlock(args.context);
  const risk = livePolicyBlock ?? await evaluateOrderRisk(args.input, {
    tradingAccountId: args.context.tradingAccount.id,
    requestedNotionalOverride: args.sizing.estimatedNotional,
    ...(args.enforceEntrySessionGuard === false
      ? { enforceEntrySessionGuard: false }
      : {}),
    ...(args.excludeOrderIntentId !== undefined
      ? { excludeOrderIntentId: args.excludeOrderIntentId }
      : {}),
  });
  const details =
    risk.details && typeof risk.details === 'object' && !Array.isArray(risk.details)
      ? (risk.details as Record<string, unknown>)
      : null;
  const session = (details?.entrySession ?? null) as Prisma.InputJsonValue | null;
  const blockers = risk.allowed
    ? []
    : [{
        code: riskRule(risk) ?? 'entry_risk_blocked',
        message: risk.reason,
        details: risk.details,
      }];

  return {
    context: args.context,
    input: args.input,
    sizing: args.sizing,
    referencePrice: args.sizing.snapshot.latestPrice,
    priceEvidence: {
      observedAt: args.sizing.snapshot.latestPriceAt,
      source: args.sizing.snapshot.latestPriceSource,
    },
    estimatedNotional: args.sizing.estimatedNotional,
    session,
    risk,
    blockers,
    warnings: [],
    permitsIntentCreation: risk.allowed,
    outcomeCode: risk.allowed
      ? 'ENTRY_ELIGIBLE'
      : livePolicyBlock
        ? 'LIVE_ENTRY_POLICY_BLOCKED'
        : 'ENTRY_RISK_BLOCKED',
  };
}

export async function evaluateAssignmentEntry(args: {
  input: PlaceOrderInput;
  enforceEntrySessionGuard?: boolean;
  excludeOrderIntentId?: number;
}) {
  const resolved = await resolveAssignmentEntryContext(args.input);
  const sized = await calculateAssignmentEntrySizing(resolved);

  return evaluateResolvedAssignmentEntry({
    context: resolved.context,
    input: sized.input,
    sizing: sized.sizing,
    ...(args.enforceEntrySessionGuard === false
      ? { enforceEntrySessionGuard: false }
      : {}),
    ...(args.excludeOrderIntentId !== undefined
      ? { excludeOrderIntentId: args.excludeOrderIntentId }
      : {}),
  });
}

const ENTRY_SESSION_BLOCK_RULES = new Set([
  'market_closed',
  'entry_open_buffer_active',
  'entry_close_buffer_active',
  'market_clock_unavailable',
  'entry_window_unavailable',
]);

/**
 * Preview-only evaluation that preserves the real entry result while continuing
 * past a temporal session block to collect session-independent risk evidence.
 * This function never creates an intent or performs a broker write.
 */
export async function evaluateAssignmentEntryPreviewDiagnostics(args: {
  input: PlaceOrderInput;
  excludeOrderIntentId?: number;
}) {
  const resolved = await resolveAssignmentEntryContext(args.input);
  const sized = await calculateAssignmentEntrySizing(resolved);
  const authoritative = await evaluateResolvedAssignmentEntry({
    context: resolved.context,
    input: sized.input,
    sizing: sized.sizing,
    ...(args.excludeOrderIntentId !== undefined
      ? { excludeOrderIntentId: args.excludeOrderIntentId }
      : {}),
  });
  const authoritativeRule = riskRule(authoritative.risk);

  if (authoritative.permitsIntentCreation || !authoritativeRule || !ENTRY_SESSION_BLOCK_RULES.has(authoritativeRule)) {
    return authoritative;
  }

  const sessionIndependent = await evaluateResolvedAssignmentEntry({
    context: resolved.context,
    input: sized.input,
    sizing: sized.sizing,
    enforceEntrySessionGuard: false,
    ...(args.excludeOrderIntentId !== undefined
      ? { excludeOrderIntentId: args.excludeOrderIntentId }
      : {}),
  });
  const blockers = [...authoritative.blockers];
  for (const blocker of sessionIndependent.blockers) {
    if (!blockers.some((existing) => existing.code === blocker.code)) blockers.push(blocker);
  }

  return {
    ...sessionIndependent,
    blockers,
    permitsIntentCreation: false,
    outcomeCode: authoritative.outcomeCode,
    session: authoritative.risk.details as Prisma.InputJsonValue,
  } satisfies AssignmentEntryEvaluation;
}
