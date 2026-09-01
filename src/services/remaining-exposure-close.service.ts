import crypto from "node:crypto";
import { PlatformRole, Prisma, SystemEventSeverity } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { HttpError } from "../errors/http-error.js";
import { BrokerWriteDeliveryError } from "../errors/broker-write-delivery-error.js";
import type {
  AlpacaOrder,
  AlpacaPosition,
} from "../integrations/alpaca/alpaca.types.js";
import { getAlpacaMarketSessionSnapshot } from "../integrations/alpaca/market-session.adapter.js";
import {
  getAlpacaOrderByClientOrderId,
  getOpenAlpacaOrders,
} from "../integrations/alpaca/orders.adapter.js";
import { getAlpacaPositionBySymbol } from "../integrations/alpaca/positions.adapter.js";
import { isNonterminalBrokerOrderStatus } from "./broker-order-lifecycle-status.service.js";
import { getLiveWriteApprovalState } from "./live-write-approval.service.js";
import { createSystemEvent } from "./system-event.service.js";
import { resolveOperationalAttentionAuthoritatively } from "./operational-attention.service.js";
import { submitVerifiedCorrectiveExitWithinAccountLock } from "./verified-exit-submission.service.js";
import {
  ACCOUNT_WORKFLOW_LOCK_FAMILIES,
  withTradingAccountWorkflowLock,
} from "./trading-account-workflow-lock.service.js";

type UserScope = { id: number; platformRole: PlatformRole };
type Exact = { coefficient: bigint; scale: number; canonical: string };
const ACTIVE_CODES = new Set([
  "EXIT_QUANTITY_MISMATCH",
  "BROKER_EXPOSURE_UNVERIFIABLE",
  "CONFLICTING_EXIT_RESERVATION",
]);
const PREVIEW_TTL_MS = 30_000;

function exact(value: unknown): Exact | null {
  const text =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const coefficient = BigInt(`${whole}${trimmed}` || "0");
  return {
    coefficient,
    scale: trimmed.length,
    canonical: trimmed ? `${whole}.${trimmed}` : whole!,
  };
}
function align(value: Exact, scale: number) {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}
function eq(left: Exact, right: Exact) {
  const scale = Math.max(left.scale, right.scale);
  return align(left, scale) === align(right, scale);
}
function add(values: Exact[]): Exact {
  const scale = Math.max(0, ...values.map((v) => v.scale));
  const coefficient = values.reduce(
    (sum, value) => sum + align(value, scale),
    0n,
  );
  return canonical({ coefficient, scale, canonical: "" });
}
function subtract(left: Exact, right: Exact): Exact | null {
  const scale = Math.max(left.scale, right.scale);
  const coefficient = align(left, scale) - align(right, scale);
  return coefficient < 0n
    ? null
    : canonical({ coefficient, scale, canonical: "" });
}
function canonical(value: Exact): Exact {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  const digits = coefficient.toString().padStart(scale + 1, "0");
  return {
    coefficient,
    scale,
    canonical: scale
      ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
      : digits,
  };
}
function fillQty(activity: {
  qty: number | null;
  rawBrokerJson: Prisma.JsonValue;
}): Exact | null {
  const raw = activity.rawBrokerJson;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const qty = (raw as Prisma.JsonObject).qty;
    const parsed = exact(qty);
    if (parsed) return parsed;
  }
  return exact(activity.qty);
}

type AttributedFillEvidence = {
  broker: string;
  mode: string;
  activityId: string;
  qty: number | null;
  rawBrokerJson: Prisma.JsonValue;
};

export function summarizeAttributedFillQuantities(
  fills: AttributedFillEvidence[],
) {
  const identities = new Map<string, Exact>();
  for (const fill of fills) {
    const activityId = fill.activityId.trim();
    const quantity = fillQty(fill);
    if (!activityId || !quantity || quantity.coefficient <= 0n)
      return { valid: false as const, quantity: null, reason: "MALFORMED_FILL" as const };
    const identity = `${fill.broker.toLowerCase()}:${fill.mode.toLowerCase()}:${activityId}`;
    const existing = identities.get(identity);
    if (existing && !eq(existing, quantity))
      return { valid: false as const, quantity: null, reason: "CONFLICTING_DUPLICATE_IDENTITY" as const };
    identities.set(identity, quantity);
  }
  return {
    valid: true as const,
    quantity: add([...identities.values()]),
    reason: null,
  };
}
function remaining(order: AlpacaOrder) {
  const qty = exact(order.qty);
  const filled = exact(order.filled_qty ?? "0");
  return qty && filled ? (subtract(qty, filled)?.canonical ?? null) : null;
}
function attemptClientOrderId(
  attentionId: number,
  positionId: number,
  revision: number,
) {
  return `ai-corrective-${attentionId}-${positionId}-r${revision}`.slice(
    0,
    128,
  );
}
function hash(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function evaluateCorrectiveRemainderEquation(args: {
  trackedQuantity: unknown;
  attributedExitFilledQuantity: unknown;
  brokerHeldQuantity: unknown;
  brokerAvailableQuantity: unknown;
}) {
  const tracked = exact(args.trackedQuantity);
  const attributed = exact(args.attributedExitFilledQuantity);
  const held = exact(args.brokerHeldQuantity);
  const available = exact(args.brokerAvailableQuantity);
  const expected = tracked && attributed ? subtract(tracked, attributed) : null;
  const eligible = Boolean(
    tracked?.coefficient &&
      attributed?.coefficient &&
      expected?.coefficient &&
      held?.coefficient &&
      available?.coefficient &&
      eq(expected!, held!) &&
      eq(held!, available!),
  );
  return {
    eligible,
    trackedQuantity: tracked?.canonical ?? null,
    attributedExitFilledQuantity: attributed?.canonical ?? null,
    expectedRemainingQuantity: expected?.canonical ?? null,
    brokerHeldQuantity: held?.canonical ?? null,
    brokerAvailableQuantity: available?.canonical ?? null,
  };
}

async function loadBase(user: UserScope, attentionId: number) {
  if (user.platformRole === PlatformRole.ACCOUNT_USER)
    throw new HttpError(403, "Operational attention access required.");
  const attention = await prisma.operationalAttention.findUnique({
    where: { id: attentionId },
    include: {
      tradingAccount: true,
      trackedPosition: { include: { security: true } },
    },
  });
  if (!attention)
    throw new HttpError(404, "Operational attention was not found.");
  if (user.platformRole !== PlatformRole.SYSTEM_OWNER) {
    const membership = await prisma.tradingAccountMembership.findUnique({
      where: {
        tradingAccountId_userId: {
          tradingAccountId: attention.tradingAccountId,
          userId: user.id,
        },
      },
      select: { id: true },
    });
    if (!membership)
      throw new HttpError(404, "Operational attention was not found.");
  }
  return attention;
}

async function evidence(
  user: UserScope,
  attentionId: number,
  previewWindow?: { observedAt: Date; validUntil: Date },
) {
  const attention = await loadBase(user, attentionId);
  const position = attention.trackedPosition;
  const blockers: Array<{ code: string; message: string; nextAction: string }> =
    [];
  if (!["OPEN", "ACKNOWLEDGED"].includes(attention.status))
    blockers.push({
      code: "ATTENTION_RESOLVED",
      message: "This operational attention episode is resolved.",
      nextAction: "Review the resolved evidence.",
    });
  if (
    !ACTIVE_CODES.has(attention.code) ||
    attention.source !== "EXIT_VERIFICATION" ||
    !position
  )
    blockers.push({
      code: "NOT_APPLICABLE",
      message:
        "This episode is not a canonical exit-verification quantity condition.",
      nextAction: "Review reconciliation.",
    });
  if (
    position &&
    (position.tradingAccountId !== attention.tradingAccountId ||
      position.securityId !== position.security.id ||
      position.symbol.toUpperCase() !== position.security.symbol.toUpperCase())
  )
    blockers.push({
      code: "IDENTITY_MISMATCH",
      message:
        "Account, position, security, or symbol identity does not agree.",
      nextAction: "Review reconciliation.",
    });
  const tracked = position ? exact(position.qty) : null;
  if (
    !tracked ||
    tracked.coefficient <= 0n ||
    position?.side.toLowerCase() !== "long"
  )
    blockers.push({
      code: "INVALID_TRACKED_POSITION",
      message:
        "Canonical tracked quantity is not a valid positive long position.",
      nextAction: "Review reconciliation.",
    });
  const fills = position
    ? await prisma.brokerActivity.findMany({
        where: {
          tradingAccountId: attention.tradingAccountId,
          trackedPositionId: position.id,
          broker: position.broker,
          activityType: "FILL",
          side: "sell",
          symbol: position.symbol,
          transactionTime: { gte: position.openedAt },
        },
        orderBy: [{ transactionTime: "asc" }, { id: "asc" }],
      })
    : [];
  const fillSummary = summarizeAttributedFillQuantities(fills);
  if (!fillSummary.valid)
    blockers.push({
      code: "FILL_ATTRIBUTION_INCOMPLETE",
      message:
        fillSummary.reason === "CONFLICTING_DUPLICATE_IDENTITY"
          ? "Duplicate attributed activity identities contain conflicting quantities."
          : "Attributed fill identity or quantity is missing or malformed.",
      nextAction: "Review reconciliation.",
    });
  const attributed = fillSummary.valid ? fillSummary.quantity : exact("0")!;
  if (attributed.coefficient === 0n)
    blockers.push({
      code: "NO_ATTRIBUTED_EXIT_FILL",
      message: "No prior attributed sell fill exists.",
      nextAction:
        "Use normal Close Position when quantities match; otherwise review fill attribution.",
    });
  const expected = tracked ? subtract(tracked, attributed) : null;
  if (!expected || expected.coefficient <= 0n)
    blockers.push({
      code: "ATTRIBUTED_QUANTITY_INVALID",
      message: "Attributed exits equal or exceed tracked quantity.",
      nextAction: "Review fill attribution.",
    });
  let brokerPosition: AlpacaPosition | null = null;
  let orders: AlpacaOrder[] = [];
  let market: Awaited<
    ReturnType<typeof getAlpacaMarketSessionSnapshot>
  > | null = null;
  try {
    if (position)
      [brokerPosition, orders, market] = await Promise.all([
        getAlpacaPositionBySymbol(
          attention.tradingAccountId,
          position.symbol,
          "manual_admin_action",
        ),
        getOpenAlpacaOrders(attention.tradingAccountId, "manual_admin_action"),
        getAlpacaMarketSessionSnapshot(attention.tradingAccountId),
      ]);
  } catch {
    blockers.push({
      code: "BROKER_STATE_UNAVAILABLE",
      message: "Fresh broker or market state cannot be verified.",
      nextAction: "Refresh after broker connectivity is restored.",
    });
  }
  const held = exact(brokerPosition?.qty);
  const available = exact(brokerPosition?.qty_available);
  if (!brokerPosition)
    blockers.push({
      code: "BROKER_POSITION_ABSENT",
      message: "The broker position is absent; there is nothing to sell.",
      nextAction: "Allow synchronization and reconciliation to finish.",
    });
  else if (brokerPosition.side !== "long")
    blockers.push({
      code: "UNEXPECTED_SHORT",
      message: "The broker position is not long; no sell action is available.",
      nextAction: "Review unexpected short exposure.",
    });
  else if (!held || !available)
    blockers.push({
      code: "BROKER_QUANTITY_INVALID",
      message: "Broker quantity is missing or malformed.",
      nextAction: "Review Alpaca and reconciliation.",
    });
  else if (expected && !eq(held, expected))
    blockers.push({
      code: "BROKER_QUANTITY_MISMATCH",
      message: `Broker quantity cannot be reconciled to the expected remainder.`,
      nextAction: "Review Alpaca and reconciliation.",
    });
  else if (!eq(held, available))
    blockers.push({
      code: "SHARES_RESERVED",
      message: "Available quantity differs from broker-held quantity.",
      nextAction: "Review Open Orders.",
    });
  const clientOrderId = position
    ? attemptClientOrderId(attention.id, position.id, attention.revision)
    : "";
  const relevantOrders = orders
    .filter(
      (order) =>
        position &&
        order.symbol.toUpperCase() === position.symbol.toUpperCase() &&
        isNonterminalBrokerOrderStatus(order.status),
    )
    .map((order) => ({
      brokerOrderId: order.id,
      clientOrderId: order.client_order_id,
      side: order.side,
      type: order.type,
      status: order.status,
      remainingQty: remaining(order),
      matchingCorrectiveAttempt: order.client_order_id === clientOrderId,
    }));
  const localCorrectiveAttempts = position
    ? await prisma.orderIntent.findMany({
        where: {
          tradingAccountId: attention.tradingAccountId,
          trackedPositionId: position.id,
          source: "remaining-exposure-close",
          OR: [
            { status: { in: ["pending", "submitting", "submitted"] } },
            { blockReason: { startsWith: "BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN" } },
          ],
        },
        select: { id: true, status: true, clientOrderId: true, blockReason: true },
      })
    : [];
  if (relevantOrders.length)
    blockers.push({
      code: relevantOrders.some((o) => o.matchingCorrectiveAttempt)
        ? "CORRECTIVE_ORDER_ACTIVE"
        : "CONFLICTING_ORDER",
      message:
        "An active order for this symbol prevents another corrective order.",
      nextAction:
        "Review Open Orders and recover or monitor the existing order.",
    });
  if (localCorrectiveAttempts.some((attempt) => attempt.clientOrderId !== clientOrderId))
    blockers.push({
      code: "CORRECTIVE_DELIVERY_UNRESOLVED",
      message: "A previous corrective attempt remains open or delivery-uncertain.",
      nextAction: "Recover or reconcile the existing corrective attempt before creating another.",
    });
  if (!market?.marketOpen)
    blockers.push({
      code: "REGULAR_SESSION_CLOSED",
      message:
        "Corrective market closes are available only during the regular session.",
      nextAction: "Wait for the regular session.",
    });
  const authority = await getLiveWriteApprovalState(attention.tradingAccountId);
  const risk = authority.capabilities.find(
    (item) => item.capability === "RISK_REDUCING",
  );
  const observationOnly =
    attention.tradingAccount.environment === "LIVE" &&
    !authority.deploymentCanWrite;
  if (observationOnly)
    blockers.push({
      code: "OBSERVATION_ONLY",
      message: "This environment cannot execute corrective Live actions.",
      nextAction: "Verify from the authoritative executor.",
    });
  if (attention.tradingAccount.environment === "LIVE" && !risk?.effective)
    blockers.push({
      code: "LIVE_AUTHORITY_REQUIRED",
      message: "Effective RISK_REDUCING authority is required.",
      nextAction: "Grant or renew authority from Readiness.",
    });
  const observedAt = previewWindow?.observedAt ?? new Date();
  const validUntil =
    previewWindow?.validUntil ??
    new Date(observedAt.getTime() + PREVIEW_TTL_MS);
  const fingerprintEvidence = {
    attentionId: attention.id,
    revision: attention.revision,
    accountId: attention.tradingAccountId,
    environment: attention.tradingAccount.environment,
    positionId: position?.id ?? null,
    securityId: position?.securityId ?? null,
    trackedQty: tracked?.canonical ?? null,
    attributedQty: attributed.canonical,
    expectedQty: expected?.canonical ?? null,
    brokerSide: brokerPosition?.side ?? null,
    heldQty: held?.canonical ?? null,
    availableQty: available?.canonical ?? null,
    orders: relevantOrders,
    localCorrectiveAttempts,
    marketOpen: market?.marketOpen ?? false,
    marketFetchedAt: market?.fetchedAt ?? null,
    policyFingerprint: risk?.fingerprints?.configurationFingerprint ?? null,
    approvalRevision: risk?.approval?.revision ?? null,
    observedAt: observedAt.toISOString(),
    validUntil: validUntil.toISOString(),
  };
  return {
    attention,
    position,
    tracked,
    attributed,
    expected,
    brokerPosition,
    held,
    available,
    relevantOrders,
    market,
    authority,
    clientOrderId,
    observedAt,
    validUntil,
    blockers,
    fingerprint: `${observedAt.getTime()}.${validUntil.getTime()}.${hash(fingerprintEvidence)}`,
  };
}

function previewWindowFromFingerprint(fingerprint: string) {
  const [observedText, validText, digest, ...extra] = fingerprint.split(".");
  const observedMs = Number(observedText);
  const validMs = Number(validText);
  if (
    extra.length ||
    !digest ||
    !/^\d+$/.test(observedText ?? "") ||
    !/^\d+$/.test(validText ?? "") ||
    !Number.isSafeInteger(observedMs) ||
    !Number.isSafeInteger(validMs) ||
    validMs - observedMs !== PREVIEW_TTL_MS
  )
    return null;
  const observedAt = new Date(observedMs);
  const validUntil = new Date(validMs);
  return { observedAt, validUntil };
}

export async function getRemainingExposureClosePreview(
  user: UserScope,
  attentionId: number,
) {
  const state = await evidence(user, attentionId);
  return {
    attentionId: state.attention.id,
    revision: state.attention.revision,
    status: state.attention.status,
    severity: state.attention.severity,
    tradingAccount: {
      id: state.attention.tradingAccountId,
      displayName: state.attention.tradingAccount.displayName,
      environment: state.attention.tradingAccount.environment,
    },
    trackedPositionId: state.position?.id ?? null,
    securityId: state.position?.securityId ?? null,
    symbol: state.position?.symbol ?? null,
    trackedQuantity: state.tracked?.canonical ?? null,
    attributedExitFilledQuantity: state.attributed.canonical,
    expectedRemainingQuantity: state.expected?.canonical ?? null,
    brokerPosition: {
      side: state.brokerPosition?.side ?? null,
      heldQuantity: state.held?.canonical ?? null,
      availableQuantity: state.available?.canonical ?? null,
    },
    activeOrders: state.relevantOrders,
    marketSession: state.market,
    deploymentAuthority: {
      role: state.authority.deploymentRole,
      canWrite:
        state.attention.tradingAccount.environment === "PAPER" ||
        state.authority.deploymentCanWrite,
    },
    liveRiskReducingAuthorization: state.authority.capabilities.find(
      (item) => item.capability === "RISK_REDUCING",
    ),
    eligible: state.blockers.length === 0,
    blockingReasons: state.blockers,
    observedAt: state.observedAt.toISOString(),
    validUntil: state.validUntil.toISOString(),
    previewFingerprint: state.fingerprint,
    canExecute: user.platformRole === PlatformRole.SYSTEM_OWNER,
    explanation:
      state.blockers[0]?.message ??
      `The complete verified broker remainder of ${state.expected?.canonical} shares may be submitted as market/DAY sell-to-close.`,
    nextAction:
      state.blockers[0]?.nextAction ??
      "Confirm the corrective close before this preview expires.",
  };
}

export async function executeRemainingExposureClose(
  user: UserScope,
  attentionId: number,
  input: { expectedRevision: number; expectedPreviewFingerprint: string },
) {
  if (user.platformRole !== PlatformRole.SYSTEM_OWNER)
    throw new HttpError(403, "System owner access required.");
  const initial = await loadBase(user, attentionId);
  const clientOrderId = initial.trackedPositionId
    ? attemptClientOrderId(
        initial.id,
        initial.trackedPositionId,
        input.expectedRevision,
      )
    : "";
  const locked = await withTradingAccountWorkflowLock({
    tradingAccountId: initial.tradingAccountId,
    workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.EXIT_SUBMISSION,
    processInstanceId: `corrective:${attentionId}:r${input.expectedRevision}`,
    execute: async () => {
      const local = await prisma.brokerOrder.findFirst({
        where: {
          tradingAccountId: initial.tradingAccountId,
          broker: "alpaca",
          clientOrderId,
        },
        include: { orderIntent: true },
      });
      if (local)
        return {
          outcome: "RECOVERED_LOCAL" as const,
          orderIntentId: local.orderIntentId,
          brokerOrderId: local.id,
          clientOrderId,
        };
      const recovered = clientOrderId
        ? await getAlpacaOrderByClientOrderId(
            initial.tradingAccountId,
            clientOrderId,
            "pending_order_idempotency_check",
          )
        : null;
      if (recovered) {
        const intent = await prisma.orderIntent.findFirst({
          where: {
            tradingAccountId: initial.tradingAccountId,
            clientOrderId,
            source: "remaining-exposure-close",
          },
        });
        if (!intent || !initial.trackedPosition)
          throw new HttpError(
            409,
            "Recovered corrective broker order has incomplete local lifecycle identity; review reconciliation.",
          );
        const existing = await prisma.brokerOrder.findFirst({
          where: {
            tradingAccountId: initial.tradingAccountId,
            broker: "alpaca",
            brokerOrderId: recovered.id,
          },
        });
        const data = {
          orderIntentId: intent.id,
          tradingAccountId: initial.tradingAccountId,
          broker: "alpaca",
          brokerOrderId: recovered.id,
          clientOrderId: recovered.client_order_id,
          symbol: recovered.symbol.toUpperCase(),
          side: recovered.side,
          status: recovered.status,
          securityId: initial.trackedPosition.securityId,
          trackedPositionId: initial.trackedPosition.id,
          rawBrokerJson: recovered as unknown as Prisma.InputJsonValue,
        };
        const materialized = existing
          ? await prisma.brokerOrder.update({
              where: { id: existing.id },
              data,
            })
          : await prisma.brokerOrder.create({ data });
        await prisma.orderIntent.update({
          where: { id: intent.id },
          data: { status: "submitted", blockReason: null },
        });
        await createSystemEvent({
          type: "corrective_close.order_recovered",
          entityType: "trackedPosition",
          entityId: initial.trackedPosition.id,
          tradingAccountId: initial.tradingAccountId,
          actorUserId: user.id,
          severity: SystemEventSeverity.INFO,
          message: `${initial.trackedPosition.symbol} corrective remainder order recovered.`,
          payloadJson: {
            attentionId,
            revision: input.expectedRevision,
            orderIntentId: intent.id,
            brokerOrderId: materialized.id,
            clientOrderId,
          },
        });
        return {
          outcome: "RECOVERED_BROKER" as const,
          orderIntentId: intent.id,
          brokerOrderId: materialized.id,
          clientOrderId,
        };
      }
      const window = previewWindowFromFingerprint(
        input.expectedPreviewFingerprint,
      );
      if (!window || window.validUntil.getTime() <= Date.now())
        throw new HttpError(
          409,
          "Corrective-close preview is stale; refresh before retrying.",
        );
      const state = await evidence(user, attentionId, window);
      if (state.attention.revision !== input.expectedRevision)
        throw new HttpError(
          409,
          "Attention revision changed; refresh the preview.",
        );
      if (state.fingerprint !== input.expectedPreviewFingerprint)
        throw new HttpError(
          409,
          "Corrective-close preview evidence changed; refresh before retrying.",
        );
      if (state.blockers.length || !state.position || !state.expected)
        throw new HttpError(
          409,
          state.blockers[0]?.message ?? "Corrective close is not eligible.",
          { blockingReasons: state.blockers },
        );
      await createSystemEvent({
        type: "corrective_close.execution_requested",
        entityType: "trackedPosition",
        entityId: state.position.id,
        tradingAccountId: state.attention.tradingAccountId,
        actorUserId: user.id,
        severity: SystemEventSeverity.INFO,
        message: `${state.position.symbol} corrective remainder close requested.`,
        payloadJson: {
          attentionId,
          revision: state.attention.revision,
          clientOrderId,
          lifecycleEquation: {
            tracked: state.tracked?.canonical,
            attributed: state.attributed.canonical,
            remainder: state.expected.canonical,
          },
        },
      });
      const intent = await prisma.orderIntent.create({
        data: {
          source: "remaining-exposure-close",
          symbol: state.position.symbol.toUpperCase(),
          side: "sell",
          orderType: "market",
          timeInForce: "day",
          qty: Number(state.expected.canonical),
          extendedHours: false,
          clientOrderId,
          status: "submitting",
          rawRequestJson: {
            source: "remaining-exposure-close",
            attentionId,
            attentionRevision: state.attention.revision,
            previewFingerprint: state.fingerprint,
            trackedQuantity: state.tracked!.canonical,
            attributedExitFilledQuantity: state.attributed.canonical,
            expectedRemainingQuantity: state.expected.canonical,
          },
          trackedPositionId: state.position.id,
          tradingAccountId: state.attention.tradingAccountId,
        },
      });
    let result;
    try {
      result = await submitVerifiedCorrectiveExitWithinAccountLock({
        verificationMode: "CORRECTIVE_REMAINDER_CLOSE",
        tradingAccountId: state.attention.tradingAccountId,
        trackedPositionId: state.position.id,
        orderIntentId: intent.id,
        securityId: state.position.securityId,
        symbol: state.position.symbol,
        localTrackedQty: state.tracked!.canonical,
        attributedExitFilledQty: state.attributed.canonical,
        intendedQty: state.expected.canonical,
        clientOrderId,
        correlationId: `attention:${attentionId}:r${state.attention.revision}`,
        order: { type: "market", timeInForce: "day" },
      });
      if (result.outcome === "RECOVERED_LOCAL")
        return {
          outcome: result.outcome,
          orderIntentId: intent.id,
          brokerOrderId: result.brokerOrderId,
          clientOrderId,
        };
      const order = result.order;
      const existingOrder = await prisma.brokerOrder.findFirst({
        where: {
          tradingAccountId: state.attention.tradingAccountId,
          broker: "alpaca",
          brokerOrderId: order.id,
        },
      });
      const orderData = {
        orderIntentId: intent.id,
        tradingAccountId: state.attention.tradingAccountId,
        broker: "alpaca",
        brokerOrderId: order.id,
        clientOrderId: order.client_order_id,
        symbol: order.symbol.toUpperCase(),
        side: order.side,
        status: order.status,
        securityId: state.position.securityId,
        trackedPositionId: state.position.id,
        rawBrokerJson: order as unknown as Prisma.InputJsonValue,
      };
      const brokerOrder = existingOrder
        ? await prisma.brokerOrder.update({
            where: { id: existingOrder.id },
            data: orderData,
          })
        : await prisma.brokerOrder.create({ data: orderData });
      await prisma.orderIntent.update({
        where: { id: intent.id },
        data: { status: "submitted", blockReason: null },
      });
      await createSystemEvent({
        type:
          result.outcome === "SUBMITTED"
            ? "corrective_close.order_submitted"
            : "corrective_close.order_recovered",
        entityType: "trackedPosition",
        entityId: state.position.id,
        tradingAccountId: state.attention.tradingAccountId,
        actorUserId: user.id,
        severity: SystemEventSeverity.INFO,
        message: `${state.position.symbol} corrective remainder order ${result.outcome === "SUBMITTED" ? "submitted" : "recovered"}.`,
        payloadJson: {
          attentionId,
          revision: state.attention.revision,
          orderIntentId: intent.id,
          brokerOrderId: brokerOrder.id,
          clientOrderId,
          quantity: state.expected.canonical,
          positionIntent: "sell_to_close",
          orderType: "market",
          timeInForce: "day",
        },
      });
      return {
        outcome: result.outcome,
        orderIntentId: intent.id,
        brokerOrderId: brokerOrder.id,
        clientOrderId,
      };
    } catch (error) {
      const classification =
        error instanceof BrokerWriteDeliveryError
          ? error.classification
          : "DELIVERY_UNCERTAIN";
      await prisma.orderIntent.updateMany({
        where: { id: intent.id },
        data: {
          status: classification === "BROKER_REJECTED" ? "failed" : "submitting",
          blockReason: `BROKER_WRITE_DELIVERY:${classification}`,
        },
      });
      await createSystemEvent({
        type:
          classification === "BROKER_REJECTED"
            ? "corrective_close.order_rejected"
            : "corrective_close.delivery_uncertain",
        entityType: "trackedPosition",
        entityId: state.position.id,
        tradingAccountId: state.attention.tradingAccountId,
        actorUserId: user.id,
        severity:
          state.attention.tradingAccount.environment === "LIVE"
            ? SystemEventSeverity.CRITICAL
            : SystemEventSeverity.ERROR,
        message:
          classification === "BROKER_REJECTED"
            ? `${state.position.symbol} corrective remainder order was explicitly rejected.`
            : `${state.position.symbol} corrective remainder order delivery is uncertain; deterministic recovery is required.`,
        payloadJson: {
          attentionId,
          revision: state.attention.revision,
          orderIntentId: intent.id,
          clientOrderId,
          deliveryClassification: classification,
        },
      });
      if (classification === "BROKER_REJECTED") {
        await prisma.operationalAttention.updateMany({
          where: {
            id: state.attention.id,
            revision: state.attention.revision,
            status: { in: ["OPEN", "ACKNOWLEDGED"] },
          },
          data: {
            revision: { increment: 1 },
            lastObservedAt: new Date(),
            occurrenceCount: { increment: 1 },
          },
        });
      }
      throw error;
    }
    },
  });
  if (locked.outcome === "ACQUIRED_AND_COMPLETED") return locked.value;
  if (locked.outcome === "WORKFLOW_ERROR") throw locked.error;
  throw new HttpError(
    503,
    `Exit submission lock was not acquired safely (${locked.outcome}).`,
  );
}

export async function reconcileRemainingExposureCloseAfterPositionClosure(args: {
  tradingAccountId: number;
  trackedPositionId: number;
}) {
  const position = await prisma.trackedPosition.findFirst({
    where: {
      id: args.trackedPositionId,
      tradingAccountId: args.tradingAccountId,
      status: "closed",
    },
  });
  if (!position) return false;
  const fills = await prisma.brokerActivity.findMany({
    where: {
      tradingAccountId: args.tradingAccountId,
      trackedPositionId: position.id,
      broker: position.broker,
      activityType: "FILL",
      side: "sell",
      symbol: position.symbol,
      transactionTime: { gte: position.openedAt },
    },
  });
  const fillSummary = summarizeAttributedFillQuantities(fills);
  const tracked = exact(position.qty);
  if (
    !tracked ||
    !fills.length ||
    !fillSummary.valid ||
    !eq(fillSummary.quantity, tracked)
  )
    return false;
  const activeCorrectiveOrders = await prisma.brokerOrder.count({
    where: {
      tradingAccountId: args.tradingAccountId,
      trackedPositionId: position.id,
      orderIntent: { source: "remaining-exposure-close" },
      status: {
        notIn: [
          "filled",
          "canceled",
          "cancelled",
          "expired",
          "rejected",
          "replaced",
          "done_for_day",
          "calculated",
        ],
      },
    },
  });
  if (activeCorrectiveOrders) return false;
  const attentions = await prisma.operationalAttention.findMany({
    where: {
      tradingAccountId: args.tradingAccountId,
      trackedPositionId: position.id,
      source: "EXIT_VERIFICATION",
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
    },
    select: { id: true, revision: true },
  });
  for (const attention of attentions)
    await resolveOperationalAttentionAuthoritatively({
      id: attention.id,
      expectedRevision: attention.revision,
      reason:
        "Broker exposure is zero and complete attributed exit fills equal the canonical tracked quantity.",
      evidence: {
        tradingAccountId: args.tradingAccountId,
        trackedPositionId: position.id,
        symbol: position.symbol,
        trackedQuantity: tracked.canonical,
        attributedExitFilledQuantity: tracked.canonical,
        brokerExposure: "ZERO_OR_ABSENT",
        reconciledAt: new Date().toISOString(),
      },
    });
  if (attentions.length)
    await createSystemEvent({
      type: "corrective_close.lifecycle_reconciled",
      entityType: "trackedPosition",
      entityId: position.id,
      tradingAccountId: args.tradingAccountId,
      severity: SystemEventSeverity.INFO,
      message: `${position.symbol} corrective lifecycle fully reconciled.`,
      payloadJson: {
        trackedPositionId: position.id,
        attributedExitFilledQuantity: tracked.canonical,
        resolvedAttentionIds: attentions.map((attention) => attention.id),
      },
    });
  return attentions.length > 0;
}
