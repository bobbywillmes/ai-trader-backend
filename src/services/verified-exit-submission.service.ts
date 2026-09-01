import {
  OperationalAttentionResolutionPolicy,
  Prisma,
  SystemEventSeverity,
} from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { BrokerWriteDeliveryError } from '../errors/broker-write-delivery-error.js';
import type { AlpacaOrder } from '../integrations/alpaca/alpaca.types.js';
import {
  getAlpacaOrderByClientOrderId,
  getOpenAlpacaOrders,
  submitVerifiedAlpacaExitOrder,
  type VerifiedAlpacaExitOrderRequest,
} from '../integrations/alpaca/orders.adapter.js';
import { getAlpacaPositionBySymbol } from '../integrations/alpaca/positions.adapter.js';
import { isNonterminalBrokerOrderStatus } from './broker-order-lifecycle-status.service.js';
import { authorizeLiveBrokerWrite } from './live-write-approval.service.js';
import {
  OPERATIONAL_ATTENTION_CODES,
  OPERATIONAL_ATTENTION_SOURCES,
  openOrObserveOperationalAttention,
  resolveOperationalAttentionAuthoritatively,
} from './operational-attention.service.js';
import { createSystemEvent } from './system-event.service.js';
import {
  ACCOUNT_WORKFLOW_LOCK_FAMILIES,
  withTradingAccountWorkflowLock,
} from './trading-account-workflow-lock.service.js';

export type ExitVerificationOutcome =
  | 'POSITION_NOT_FOUND'
  | 'UNEXPECTED_SHORT_POSITION'
  | 'QUANTITY_MISMATCH'
  | 'RESERVED_QUANTITY'
  | 'CONFLICTING_OPEN_SELL_ORDER'
  | 'BROKER_STATE_UNAVAILABLE';

export type VerifiedExitContext = {
  tradingAccountId: number;
  trackedPositionId: number;
  orderIntentId: number;
  securityId: number;
  symbol: string;
  localTrackedQty: number | string;
  intendedQty: number | string;
  clientOrderId: string;
  correlationId?: string | null;
  order:
    | { type: 'market'; timeInForce: 'day' | 'gtc' }
    | {
        type: 'trailing_stop';
        timeInForce: 'day' | 'gtc';
        trailPercent: string;
      };
};

export type VerifiedExitSubmissionResult =
  | { outcome: 'RECOVERED_LOCAL'; brokerOrderId: number }
  | { outcome: 'RECOVERED_BROKER'; order: AlpacaOrder }
  | { outcome: 'SUBMITTED'; order: AlpacaOrder };

type ExactDecimal = { coefficient: bigint; scale: number; canonical: string };

export function parseExactPositiveDecimal(value: unknown): ExactDecimal | null {
  const parsed = parseExactNonNegativeDecimal(value);
  return parsed && parsed.coefficient > 0n ? parsed : null;
}

export function parseExactNonNegativeDecimal(value: unknown): ExactDecimal | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const coefficient = BigInt(`${whole}${trimmedFraction}` || '0');
  return {
    coefficient,
    scale: trimmedFraction.length,
    canonical: trimmedFraction ? `${whole}.${trimmedFraction}` : whole!,
  };
}

function compareDecimal(left: ExactDecimal, right: ExactDecimal) {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

function equalDecimal(left: ExactDecimal, right: ExactDecimal) {
  if (left.scale === right.scale) return left.coefficient === right.coefficient;
  const scale = Math.max(left.scale, right.scale);
  return left.coefficient * 10n ** BigInt(scale - left.scale) ===
    right.coefficient * 10n ** BigInt(scale - right.scale);
}

function subtractDecimal(left: ExactDecimal, right: ExactDecimal): string | null {
  const scale = Math.max(left.scale, right.scale);
  const difference = left.coefficient * 10n ** BigInt(scale - left.scale) -
    right.coefficient * 10n ** BigInt(scale - right.scale);
  if (difference < 0n) return null;
  if (scale === 0) return difference.toString();
  const padded = difference.toString().padStart(scale + 1, '0');
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}


type ConflictingOrderEvidence = {
  type: string;
  status: string;
  qty: string | null;
  filledQty: string | null;
  remainingQty: string | null;
  limitPrice: string | null;
  stopPrice: string | null;
  trailPrice: string | null;
  trailPercent: string | null;
};

function formatBrokerPrice(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function conflictMessage(symbol: string, held: string, conflicts: ConflictingOrderEvidence[]) {
  if (conflicts.length === 1) {
    const order = conflicts[0]!;
    const price = order.limitPrice
      ? `$${formatBrokerPrice(order.limitPrice)} limit`
      : order.stopPrice
        ? `$${formatBrokerPrice(order.stopPrice)} stop`
        : order.trailPercent
          ? `${order.trailPercent}% trailing-stop`
          : order.trailPrice
            ? `$${formatBrokerPrice(order.trailPrice)} trailing-stop`
            : order.type.replaceAll('_', ' ');
    return `Close blocked: ${symbol}'s ${held} shares are reserved by an open ${price} sell. Cancel or complete that order, then retry. No additional sell was submitted.`;
  }
  return `Close blocked: ${symbol}'s ${held} shares are reserved by ${conflicts.length} open sell orders. Review or cancel those orders, or allow them to complete, then retry. No additional sell was submitted.`;
}

function severity(environment: 'PAPER' | 'LIVE') {
  return environment === 'LIVE' ? SystemEventSeverity.CRITICAL : SystemEventSeverity.ERROR;
}

function deploymentAuthority() {
  return {
    nodeEnvironment: env.NODE_ENV,
    liveWriteDeploymentRole: env.LIVE_WRITE_DEPLOYMENT_ROLE,
    authoritativeProductionExecutor:
      env.NODE_ENV === 'production' && env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR',
  };
}

async function block(args: {
  context: VerifiedExitContext;
  environment: 'PAPER' | 'LIVE';
  outcome: ExitVerificationOutcome;
  message: string;
  evidence: Record<string, unknown>;
}): Promise<never> {
  const observedAt = new Date();
  const evidence = {
    tradingAccountId: args.context.tradingAccountId,
    environment: args.environment,
    ...deploymentAuthority(),
    trackedPositionId: args.context.trackedPositionId,
    orderIntentId: args.context.orderIntentId,
    securityId: args.context.securityId,
    symbol: args.context.symbol.toUpperCase(),
    localTrackedQty: args.context.localTrackedQty,
    intendedQty: args.context.intendedQty,
    stableClientOrderId: args.context.clientOrderId,
    correlationId: args.context.correlationId ?? null,
    verificationTimestamp: observedAt.toISOString(),
    verificationOutcome: args.outcome,
    authorizationResult: 'NOT_ATTEMPTED',
    ...args.evidence,
  };
  const fingerprint = `exit-safety:${args.context.tradingAccountId}:${args.context.trackedPositionId}:${args.outcome}`;
  await prisma.orderIntent.updateMany({
    where: { id: args.context.orderIntentId },
    data: { status: 'blocked', blockReason: `EXIT_VERIFICATION:${args.outcome}` },
  });
  try {
    const existingAttention = await prisma.operationalAttention.findUnique({
      where: { activeKey: fingerprint },
      select: { id: true },
    });
    const event = existingAttention ? null : await createSystemEvent({
      type: `exit.verification_blocked.${args.outcome.toLowerCase()}`,
      entityType: 'trackedPosition',
      entityId: args.context.trackedPositionId,
      tradingAccountId: args.context.tradingAccountId,
      severity: severity(args.environment),
      message: args.message,
      payloadJson: evidence as Prisma.InputJsonValue,
    });
    await openOrObserveOperationalAttention({
      tradingAccountId: args.context.tradingAccountId,
      trackedPositionId: args.context.trackedPositionId,
      orderIntentId: args.context.orderIntentId,
      orderIntentIsObservationContext: true,
      code: args.outcome === 'UNEXPECTED_SHORT_POSITION'
        ? OPERATIONAL_ATTENTION_CODES.UNEXPECTED_SHORT_POSITION
        : args.outcome === 'CONFLICTING_OPEN_SELL_ORDER' || args.outcome === 'RESERVED_QUANTITY'
          ? OPERATIONAL_ATTENTION_CODES.CONFLICTING_EXIT_RESERVATION
          : args.outcome === 'QUANTITY_MISMATCH'
            ? OPERATIONAL_ATTENTION_CODES.EXIT_QUANTITY_MISMATCH
            : OPERATIONAL_ATTENTION_CODES.BROKER_EXPOSURE_UNVERIFIABLE,
      source: OPERATIONAL_ATTENTION_SOURCES.EXIT_VERIFICATION,
      severity: severity(args.environment),
      title: args.outcome === 'CONFLICTING_OPEN_SELL_ORDER'
        ? 'Exit blocked by existing sell order'
        : `Exit verification blocked: ${args.outcome}`,
      message: args.message,
      details: evidence,
      fingerprint,
      resolutionPolicy: OperationalAttentionResolutionPolicy.AUTHORITATIVE_ONLY,
      observedAt,
      observedSystemEventId: event?.id ?? null,
    });
  } catch (error) {
    try {
      await createSystemEvent({
        type: 'exit.verification_attention_persistence_failed',
        entityType: 'trackedPosition',
        entityId: args.context.trackedPositionId,
        tradingAccountId: args.context.tradingAccountId,
        severity: severity(args.environment),
        message: `${args.context.symbol.toUpperCase()} exit was safely blocked before broker submission, but operational attention could not be recorded.`,
        payloadJson: {
          ...evidence,
          attentionPersistenceErrorType: error instanceof Error ? error.name : 'UnknownError',
        } as Prisma.InputJsonValue,
      });
    } catch {
      // The primary pre-submit block remains authoritative even if diagnostic persistence also fails.
    }
    throw new HttpError(
      503,
      `${args.context.symbol.toUpperCase()} close was safely blocked before broker submission, but operational attention could not be refreshed. Retry after the internal issue is corrected. No sell was submitted.`,
      { ...evidence, attentionPersistenceFailed: true },
    );
  }
  throw new HttpError(409, args.message, evidence);
}

async function executeVerifiedExit(context: VerifiedExitContext): Promise<VerifiedExitSubmissionResult> {
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: context.tradingAccountId },
    select: { environment: true },
  });
  const symbol = context.symbol.toUpperCase();

  const localOrder = await prisma.brokerOrder.findFirst({
    where: { tradingAccountId: context.tradingAccountId, broker: 'alpaca', clientOrderId: context.clientOrderId },
    select: { id: true },
  });
  if (localOrder) return { outcome: 'RECOVERED_LOCAL', brokerOrderId: localOrder.id };

  let recovered: AlpacaOrder | null;
  try {
    recovered = await getAlpacaOrderByClientOrderId(
      context.tradingAccountId,
      context.clientOrderId,
      'pending_order_idempotency_check',
    );
  } catch (error) {
    return block({ context, environment: account.environment, outcome: 'BROKER_STATE_UNAVAILABLE', message: `${symbol} deterministic exit recovery could not be verified.`, evidence: { failureClassification: 'CLIENT_ORDER_ID_LOOKUP_FAILED', error: error instanceof Error ? error.message : 'Unknown lookup failure.' } });
  }
  if (recovered) return { outcome: 'RECOVERED_BROKER', order: recovered };

  let position;
  let openOrders: AlpacaOrder[];
  try {
    position = await getAlpacaPositionBySymbol(context.tradingAccountId, symbol, 'manual_admin_action');
  } catch (error) {
    return block({ context, environment: account.environment, outcome: 'BROKER_STATE_UNAVAILABLE', message: `${symbol} broker position lookup failed; no sell was submitted.`, evidence: { failureClassification: 'POSITION_LOOKUP_FAILED', error: error instanceof Error ? error.message : 'Unknown lookup failure.' } });
  }
  try {
    openOrders = await getOpenAlpacaOrders(context.tradingAccountId, 'manual_admin_action');
  } catch (error) {
    return block({ context, environment: account.environment, outcome: 'BROKER_STATE_UNAVAILABLE', message: `${symbol} open-order lookup failed; no sell was submitted.`, evidence: { failureClassification: 'OPEN_ORDER_LOOKUP_FAILED', error: error instanceof Error ? error.message : 'Unknown lookup failure.' } });
  }

  if (!position) return block({ context, environment: account.environment, outcome: 'POSITION_NOT_FOUND', message: `${symbol} is absent at the broker; no sell was submitted.`, evidence: { brokerPositionSide: null, brokerHeldQty: null, brokerAvailableQty: null } });
  if (position.symbol.toUpperCase() !== symbol || position.side !== 'long') {
    const outcome = position.side === 'short' ? 'UNEXPECTED_SHORT_POSITION' : 'BROKER_STATE_UNAVAILABLE';
    return block({ context, environment: account.environment, outcome, message: position.side === 'short' ? `${symbol} is short at the broker. All sell automation is blocked.` : `${symbol} broker position identity is ambiguous.`, evidence: { brokerAssetId: position.asset_id, brokerSymbol: position.symbol, brokerPositionSide: position.side, brokerHeldQty: position.qty, brokerAvailableQty: position.qty_available ?? null } });
  }

  const held = parseExactPositiveDecimal(position.qty);
  const available = parseExactNonNegativeDecimal(position.qty_available);
  const intended = parseExactPositiveDecimal(context.intendedQty);
  const local = parseExactPositiveDecimal(context.localTrackedQty);
  if (!held || !available || !intended || !local) return block({ context, environment: account.environment, outcome: 'BROKER_STATE_UNAVAILABLE', message: `${symbol} quantity evidence is missing or malformed; no sell was submitted.`, evidence: { brokerPositionSide: position.side, brokerHeldQty: position.qty, brokerAvailableQty: position.qty_available ?? null } });

  const conflicts = openOrders
    .filter((order) => order.symbol.toUpperCase() === symbol && order.side === 'sell' && isNonterminalBrokerOrderStatus(order.status) && order.client_order_id !== context.clientOrderId)
    .map((order) => {
      const qty = parseExactPositiveDecimal(order.qty);
      const filled = order.filled_qty === undefined || order.filled_qty === null
        ? parseExactNonNegativeDecimal('0')
        : parseExactNonNegativeDecimal(order.filled_qty);
      return {
        brokerOrderId: order.id, clientOrderId: order.client_order_id, type: order.type,
        status: order.status, qty: order.qty ?? null, filledQty: order.filled_qty ?? null,
        remainingQty: qty && filled ? subtractDecimal(qty, filled) : null,
        limitPrice: order.limit_price ?? null, stopPrice: order.stop_price ?? null,
        trailPrice: order.trail_price ?? null, trailPercent: order.trail_percent ?? null,
      };
    });
  if (conflicts.some((order) => order.remainingQty === null)) return block({ context, environment: account.environment, outcome: 'BROKER_STATE_UNAVAILABLE', message: `${symbol} has an active sell order with ambiguous remaining quantity.`, evidence: { brokerPositionSide: position.side, brokerHeldQty: held.canonical, brokerAvailableQty: available.canonical, conflictingActiveSellOrders: conflicts } });
  if (conflicts.length) return block({ context, environment: account.environment, outcome: 'CONFLICTING_OPEN_SELL_ORDER', message: conflictMessage(symbol, held.canonical, conflicts), evidence: { brokerPositionSide: position.side, brokerHeldQty: held.canonical, brokerAvailableQty: available.canonical, conflictingActiveSellOrders: conflicts, nextAction: 'Review or cancel the active sell order(s), or allow them to complete, then retry.' } });
  if (!equalDecimal(held, intended) || !equalDecimal(held, local)) return block({ context, environment: account.environment, outcome: 'QUANTITY_MISMATCH', message: `${symbol} held, local, and intended quantities do not match exactly.`, evidence: { brokerPositionSide: position.side, brokerHeldQty: held.canonical, brokerAvailableQty: available.canonical } });
  if (compareDecimal(available, held) > 0) return block({ context, environment: account.environment, outcome: 'RESERVED_QUANTITY', message: `${symbol} broker-available quantity exceeds held quantity; no sell was submitted.`, evidence: { brokerPositionSide: position.side, brokerHeldQty: held.canonical, brokerAvailableQty: available.canonical, failureClassification: 'AVAILABLE_QUANTITY_EXCEEDS_HELD' } });
  if (!equalDecimal(held, available)) return block({ context, environment: account.environment, outcome: 'RESERVED_QUANTITY', message: `${symbol} broker-available quantity is lower than held quantity; no sell was submitted.`, evidence: { brokerPositionSide: position.side, brokerHeldQty: held.canonical, brokerAvailableQty: available.canonical, conflictingActiveSellOrders: conflicts } });

  const clearedAttentions = await prisma.operationalAttention.findMany({
    where: {
      tradingAccountId: context.tradingAccountId,
      trackedPositionId: context.trackedPositionId,
      source: OPERATIONAL_ATTENTION_SOURCES.EXIT_VERIFICATION,
      status: { in: ['OPEN', 'ACKNOWLEDGED'] },
    },
    select: { id: true, revision: true, fingerprint: true },
  });
  for (const attention of clearedAttentions) {
    await resolveOperationalAttentionAuthoritatively({
      id: attention.id,
      expectedRevision: attention.revision,
      reason: 'A complete fresh broker verification no longer observed this exit-safety condition.',
      evidence: {
        fingerprint: attention.fingerprint,
        tradingAccountId: context.tradingAccountId,
        trackedPositionId: context.trackedPositionId,
        symbol,
        brokerPositionSide: position.side,
        brokerHeldQty: held.canonical,
        brokerAvailableQty: available.canonical,
        intendedQty: intended.canonical,
        verifiedAt: new Date().toISOString(),
      },
    });
  }

  await authorizeLiveBrokerWrite(context.tradingAccountId, 'RISK_REDUCING_WRITE');
  const payload: VerifiedAlpacaExitOrderRequest = {
    symbol,
    side: 'sell',
    position_intent: 'sell_to_close',
    type: context.order.type,
    time_in_force: context.order.timeInForce,
    qty: intended.canonical,
    client_order_id: context.clientOrderId,
    ...(context.order.type === 'trailing_stop' ? { trail_percent: context.order.trailPercent } : {}),
  };
  let order: AlpacaOrder;
  try {
    order = await submitVerifiedAlpacaExitOrder(
      context.tradingAccountId,
      payload,
      context.order.type === 'trailing_stop' ? 'protective_order_submission' : 'position_close',
    );
  } catch (error) {
    if (error instanceof BrokerWriteDeliveryError && error.classification === 'BROKER_REJECTED') {
      try {
        const recoveredAfterRejection = await getAlpacaOrderByClientOrderId(
          context.tradingAccountId,
          context.clientOrderId,
          'pending_order_idempotency_check',
        );
        if (recoveredAfterRejection) return { outcome: 'RECOVERED_BROKER', order: recoveredAfterRejection };
      } catch {
        throw new BrokerWriteDeliveryError({
          classification: 'DELIVERY_UNCERTAIN',
          message: 'Broker rejection could not be confirmed because deterministic recovery failed.',
          cause: error,
        });
      }
    }
    throw error;
  }
  return { outcome: 'SUBMITTED', order };
}

export async function submitVerifiedExit(context: VerifiedExitContext) {
  const locked = await withTradingAccountWorkflowLock({
    tradingAccountId: context.tradingAccountId,
    workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.EXIT_SUBMISSION,
    processInstanceId: `exit:${context.orderIntentId}:${context.clientOrderId}`,
    execute: () => executeVerifiedExit(context),
  });
  if (locked.outcome === 'ACQUIRED_AND_COMPLETED') return locked.value;
  if (locked.outcome === 'WORKFLOW_ERROR') throw locked.error;
  throw new HttpError(503, `Exit submission lock was not acquired safely (${locked.outcome}).`);
}
