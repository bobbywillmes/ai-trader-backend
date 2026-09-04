import { SystemEventSeverity, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { getOpenAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';
import {
  isTerminalBrokerOrderStatus,
  NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
  normalizeBrokerOrderStatus,
} from './broker-order-lifecycle-status.service.js';
import { createSystemEvent } from './system-event.service.js';
import { getNormalizedPositions } from './positions.service.js';
import { markPositionExitStateAttentionRequired } from './position-exit-state.service.js';
import { resolveDefaultTradingAccountId } from './trading-account.service.js';
import {
  enumerateLifecycleAccounts,
  type LifecycleAccountEligibility,
} from './lifecycle-account-eligibility.service.js';
import { ACCOUNT_WORKFLOW_LOCK_FAMILIES } from './trading-account-workflow-lock.service.js';
import { runTradingAccountWorkflow } from './trading-account-workflow-runner.service.js';
import { diagnoseHistoricalOrderLifecycle } from './historical-order-lifecycle-diagnostic.service.js';
import {
  projectReconciliationOperationalAttention,
  resolveClearedExitReservationAttention,
} from './reconciliation-operational-attention.service.js';
import { recoverDeterministicallyAbsentStaleCloseIntents } from './stale-close-intent-recovery.service.js';

export type ReconciliationSeverity = 'info' | 'warn' | 'critical';

export function reconciliationExposureUnavailableSeverity(
  environment: 'PAPER' | 'LIVE',
  authoritativeProductionExecutor =
    env.NODE_ENV === 'production' &&
    env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR'
) {
  if (environment === 'PAPER') return SystemEventSeverity.ERROR;
  return authoritativeProductionExecutor
    ? SystemEventSeverity.CRITICAL
    : SystemEventSeverity.WARNING;
}

export type ReconciliationFindingCode =
  | 'tracked_position_missing_at_broker'
  | 'broker_position_untracked'
  | 'trail_order_missing_after_unlock'
  | 'trail_order_problem_status'
  | 'trail_order_status_mismatch'
  | 'position_quantity_mismatch'
  | 'position_side_mismatch'
  | 'unexpected_short_position'
  | 'local_nonterminal_order_missing_at_broker'
  | 'local_order_status_stale_terminal_broker_order'
  | 'historical_filled_entry_position_link_missing'
  | 'broker_order_untracked'
  | 'stale_submitting_intent'
  | 'position_attribution_missing';

export type ReconciliationFinding = {
  tradingAccountId?: number;
  code: ReconciliationFindingCode;
  severity: ReconciliationSeverity;
  entityType:
    | 'trackedPosition'
    | 'brokerPosition'
    | 'brokerOrder'
    | 'orderIntent';
  entityId: string;
  symbol: string;
  message: string;
  attentionCode?: string;
  details?: Record<string, unknown>;
};

export type ReconciliationExitState = {
  targetUnlocked?: boolean | null;
  trailClientOrderId?: string | null;
  trailBrokerOrderId?: string | null;
  trailOrderStatus?: string | null;
  attentionRequired?: boolean | null;
};

export type ReconciliationTrackedPosition = {
  id: number;
  tradingAccountId?: number | null;
  broker: string;
  symbol: string;
  status: string;
  side?: string | null;
  qty?: number | null;
  subscriptionId?: number | null;
  tradingAccountSubscriptionId?: number | null;
  configSnapshotJson?: unknown | null;
  exitState?: ReconciliationExitState | null;
};

export type ReconciliationBrokerPosition = {
  broker?: string | null;
  symbol: string;
  qty?: string | number | null;
  side?: string | null;
};

export type ReconciliationBrokerOrder = {
  broker?: string | null;
  id?: string | null;
  client_order_id?: string | null;
  clientOrderId?: string | null;
  symbol: string;
  side?: string | null;
  qty?: string | number | null;
  type?: string | null;
  status?: string | null;
};

export type ReconciliationInput = {
  trackedPositions: ReconciliationTrackedPosition[];
  brokerPositions: ReconciliationBrokerPosition[];
  brokerOrders?: ReconciliationBrokerOrder[];
  localOrders?: ReconciliationBrokerOrder[];
  defaultBroker?: string;
};

const ACTIVE_TRACKED_POSITION_STATUSES = new Set(['open', 'closing']);

function normalizeBroker(value: string | null | undefined, fallback: string) {
  return (value ?? fallback).trim().toLowerCase();
}

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

function positionKey(args: {
  broker: string | null | undefined;
  symbol: string;
  defaultBroker: string;
}) {
  return `${normalizeBroker(args.broker, args.defaultBroker)}:${normalizeSymbol(
    args.symbol
  )}`;
}

function getBrokerOrderClientId(order: ReconciliationBrokerOrder) {
  return order.client_order_id ?? order.clientOrderId ?? null;
}

function getBrokerOrderId(order: ReconciliationBrokerOrder) {
  return order.id ?? null;
}

function getOrderLookupKey(order: ReconciliationBrokerOrder) {
  const clientOrderId = getBrokerOrderClientId(order);

  if (clientOrderId) {
    return `client:${clientOrderId}`;
  }

  const orderId = getBrokerOrderId(order);

  if (orderId) {
    return `broker:${orderId}`;
  }

  return null;
}

function findBrokerOrderForExitState(args: {
  exitState: ReconciliationExitState;
  brokerOrdersByLookupKey: Map<string, ReconciliationBrokerOrder>;
}) {
  const clientOrderId = args.exitState.trailClientOrderId;
  const brokerOrderId = args.exitState.trailBrokerOrderId;

  if (clientOrderId) {
    const order = args.brokerOrdersByLookupKey.get(`client:${clientOrderId}`);

    if (order) {
      return order;
    }
  }

  if (brokerOrderId) {
    const order = args.brokerOrdersByLookupKey.get(`broker:${brokerOrderId}`);

    if (order) {
      return order;
    }
  }

  return null;
}

function getTrailProblemAttentionCode(status: string) {
  switch (normalizeBrokerOrderStatus(status)) {
    case 'rejected':
      return 'trail_order_rejected';
    case 'canceled':
      return 'trail_order_canceled';
    case 'expired':
      return 'trail_order_expired';
    case 'replaced':
      return 'trail_order_replaced_unlinked';
    case 'done_for_day':
      return 'trail_order_done_for_day';
    case 'calculated':
      return 'trail_order_calculated';
    default:
      return 'trail_order_problem_status';
  }
}

export function reconcileSnapshots(input: ReconciliationInput) {
  const defaultBroker = input.defaultBroker ?? 'alpaca';
  const findings: ReconciliationFinding[] = [];

  for (const brokerPosition of input.brokerPositions) {
    if (brokerPosition.side?.trim().toLowerCase() !== 'short') continue;
    const key = positionKey({ broker: brokerPosition.broker, symbol: brokerPosition.symbol, defaultBroker });
    findings.push({
      code: 'unexpected_short_position', severity: 'critical', entityType: 'brokerPosition', entityId: key,
      symbol: normalizeSymbol(brokerPosition.symbol),
      message: `${brokerPosition.symbol} is short at the broker. Sell automation is blocked and AI Trader will not automatically buy to cover.`,
      details: { broker: normalizeBroker(brokerPosition.broker, defaultBroker), brokerSide: brokerPosition.side, brokerQty: brokerPosition.qty ?? null },
    });
  }

  const activeTrackedPositions = input.trackedPositions.filter((position) =>
    ACTIVE_TRACKED_POSITION_STATUSES.has(position.status)
  );

  const brokerPositionKeys = new Set(
    input.brokerPositions.map((position) =>
      positionKey({
        broker: position.broker,
        symbol: position.symbol,
        defaultBroker,
      })
    )
  );
  const brokerPositionsByKey = new Map(
    input.brokerPositions.map((position) => [
      positionKey({
        broker: position.broker,
        symbol: position.symbol,
        defaultBroker,
      }),
      position,
    ])
  );

  const activeTrackedPositionKeys = new Set(
    activeTrackedPositions.map((position) =>
      positionKey({
        broker: position.broker,
        symbol: position.symbol,
        defaultBroker,
      })
    )
  );

  const brokerOrdersByLookupKey = new Map<string, ReconciliationBrokerOrder>();

  for (const order of input.brokerOrders ?? []) {
    const lookupKey = getOrderLookupKey(order);

    if (lookupKey) {
      brokerOrdersByLookupKey.set(lookupKey, order);
    }
  }

  for (const position of activeTrackedPositions) {
    const key = positionKey({
      broker: position.broker,
      symbol: position.symbol,
      defaultBroker,
    });

    if (
      position.subscriptionId === null ||
      position.tradingAccountSubscriptionId === null ||
      position.configSnapshotJson === null
    ) {
      findings.push({
        code: 'position_attribution_missing', severity: 'critical',
        entityType: 'trackedPosition', entityId: String(position.id),
        symbol: normalizeSymbol(position.symbol),
        message: `${position.symbol} has missing lifecycle attribution required for exit evaluation.`,
        details: {
          tradingAccountId: position.tradingAccountId ?? null,
          trackedPositionId: position.id,
          repairType: 'RESOLVE_POSITION_ATTRIBUTION',
          diagnosisRequired: true,
          subscriptionId: position.subscriptionId ?? null,
          tradingAccountSubscriptionId: position.tradingAccountSubscriptionId ?? null,
          configSnapshotPresent: position.configSnapshotJson != null,
        },
      });
    }

    if (!brokerPositionKeys.has(key)) {
      findings.push({
        code: 'tracked_position_missing_at_broker',
        severity: 'warn',
        entityType: 'trackedPosition',
        entityId: String(position.id),
        symbol: normalizeSymbol(position.symbol),
        message: `${position.symbol} is active in the backend but missing from broker open positions.`,
        details: {
          broker: position.broker,
          status: position.status,
        },
      });
    }

    const brokerPosition = brokerPositionsByKey.get(key);
    if (brokerPosition) {
      const localQty = Math.abs(Number(position.qty));
      const brokerQty = Math.abs(Number(brokerPosition.qty));
      if (
        position.qty !== null &&
        position.qty !== undefined &&
        brokerPosition.qty !== null &&
        brokerPosition.qty !== undefined &&
        Number.isFinite(localQty) &&
        Number.isFinite(brokerQty) &&
        Math.abs(localQty - brokerQty) > 0.000001
      ) {
        findings.push({
          code: 'position_quantity_mismatch',
          severity: 'critical',
          entityType: 'trackedPosition',
          entityId: String(position.id),
          symbol: normalizeSymbol(position.symbol),
          message: `${position.symbol} quantity differs between backend and broker.`,
          details: { localQty, brokerQty },
        });
      }
      if (
        position.side &&
        brokerPosition.side &&
        position.side.toLowerCase() !== brokerPosition.side.toLowerCase()
      ) {
        findings.push({
          code: 'position_side_mismatch',
          severity: 'critical',
          entityType: 'trackedPosition',
          entityId: String(position.id),
          symbol: normalizeSymbol(position.symbol),
          message: `${position.symbol} side differs between backend and broker.`,
          details: {
            localSide: position.side,
            brokerSide: brokerPosition.side,
          },
        });
      }
    }

    const exitState = position.exitState;

    if (!exitState?.targetUnlocked) {
      continue;
    }

    if (!exitState.trailClientOrderId && !exitState.trailBrokerOrderId) {
      findings.push({
        code: 'trail_order_missing_after_unlock',
        severity: 'critical',
        entityType: 'trackedPosition',
        entityId: String(position.id),
        symbol: normalizeSymbol(position.symbol),
        attentionCode: 'trail_order_missing_after_unlock',
        message: `${position.symbol} target is unlocked, but no protective trailing-stop order is linked.`,
        details: {
          targetUnlocked: exitState.targetUnlocked,
          trailClientOrderId: exitState.trailClientOrderId ?? null,
          trailBrokerOrderId: exitState.trailBrokerOrderId ?? null,
          previousAttentionRequired: exitState.attentionRequired ?? false,
        },
      });

      continue;
    }

    const brokerOrder = findBrokerOrderForExitState({
      exitState,
      brokerOrdersByLookupKey,
    });

    if (!brokerOrder) {
      continue;
    }

    const brokerStatus = brokerOrder.status
      ? normalizeBrokerOrderStatus(brokerOrder.status)
      : null;
    const localStatus = exitState.trailOrderStatus
      ? normalizeBrokerOrderStatus(exitState.trailOrderStatus)
      : null;

    if (
      brokerStatus &&
      ((isTerminalBrokerOrderStatus(brokerStatus) &&
        brokerStatus !== 'filled') ||
        brokerStatus === 'suspended')
    ) {
      findings.push({
        code: 'trail_order_problem_status',
        severity: 'critical',
        entityType: 'trackedPosition',
        entityId: String(position.id),
        symbol: normalizeSymbol(position.symbol),
        attentionCode: getTrailProblemAttentionCode(brokerStatus),
        message: `${position.symbol} protective trailing-stop order has broker status: ${brokerStatus}.`,
        details: {
          brokerOrderId: getBrokerOrderId(brokerOrder),
          clientOrderId: getBrokerOrderClientId(brokerOrder),
          localStatus,
          brokerStatus,
          previousAttentionRequired: exitState.attentionRequired ?? false,
        },
      });
    }

    if (localStatus && brokerStatus && localStatus !== brokerStatus) {
      findings.push({
        code: 'trail_order_status_mismatch',
        severity: 'warn',
        entityType: 'trackedPosition',
        entityId: String(position.id),
        symbol: normalizeSymbol(position.symbol),
        message: `${position.symbol} trailing-stop status differs between backend and broker.`,
        details: {
          localStatus,
          brokerStatus,
          brokerOrderId: getBrokerOrderId(brokerOrder),
          clientOrderId: getBrokerOrderClientId(brokerOrder),
        },
      });
    }
  }

  for (const brokerPosition of input.brokerPositions) {
    const key = positionKey({
      broker: brokerPosition.broker,
      symbol: brokerPosition.symbol,
      defaultBroker,
    });

    if (activeTrackedPositionKeys.has(key)) {
      continue;
    }

    findings.push({
      code: 'broker_position_untracked',
      severity: 'critical',
      entityType: 'brokerPosition',
      entityId: key,
      symbol: normalizeSymbol(brokerPosition.symbol),
      message: `${brokerPosition.symbol} is open at the broker but has no active tracked position.`,
      details: {
        broker: normalizeBroker(brokerPosition.broker, defaultBroker),
        qty: brokerPosition.qty ?? null,
        side: brokerPosition.side ?? null,
      },
    });
  }

  const localOrderKeys = new Set(
    (input.localOrders ?? [])
      .map(getOrderLookupKey)
      .filter((key): key is string => key !== null)
  );
  for (const position of activeTrackedPositions) {
    if (position.exitState?.trailClientOrderId) {
      localOrderKeys.add(`client:${position.exitState.trailClientOrderId}`);
    }
    if (position.exitState?.trailBrokerOrderId) {
      localOrderKeys.add(`broker:${position.exitState.trailBrokerOrderId}`);
    }
  }
  const brokerOrderKeys = new Set(
    (input.brokerOrders ?? [])
      .map(getOrderLookupKey)
      .filter((key): key is string => key !== null)
  );

  for (const order of input.localOrders ?? []) {
    const key = getOrderLookupKey(order);
    if (!key || brokerOrderKeys.has(key)) continue;
    findings.push({
      code: 'local_nonterminal_order_missing_at_broker',
      severity: 'warn',
      entityType: 'brokerOrder',
      entityId: key,
      symbol: normalizeSymbol(order.symbol),
      message: `${order.symbol} is nonterminal locally but missing from broker open orders.`,
      details: {
        brokerOrderId: getBrokerOrderId(order),
        clientOrderId: getBrokerOrderClientId(order),
      },
    });
  }

  for (const order of input.brokerOrders ?? []) {
    const key = getOrderLookupKey(order);
    if (!key || localOrderKeys.has(key)) continue;
    findings.push({
      code: 'broker_order_untracked',
      severity: 'warn',
      entityType: 'brokerOrder',
      entityId: key,
      symbol: normalizeSymbol(order.symbol),
      message: `${order.symbol} broker order is not tracked locally for this account.`,
      details: {
        brokerOrderId: getBrokerOrderId(order),
        clientOrderId: getBrokerOrderClientId(order),
      },
    });
  }

  return findings;
}

export function refineHistoricalMissingOrderFindings(
  findings: ReconciliationFinding[],
  candidates: Awaited<
    ReturnType<typeof diagnoseHistoricalOrderLifecycle>
  >['candidates']
) {
  const historicalByLookupKey = new Map<
    string,
    (typeof candidates)[number]
  >(
    candidates.flatMap((candidate) => [
      [`broker:${candidate.brokerOrderId}`, candidate] as const,
      [`client:${candidate.clientOrderId}`, candidate] as const,
    ])
  );
  for (let index = findings.length - 1; index >= 0; index -= 1) {
    const finding = findings[index]!;
    if (finding.code !== 'local_nonterminal_order_missing_at_broker') continue;
    const candidate = historicalByLookupKey.get(finding.entityId);
    if (!candidate) continue;
    const terminalLocal = candidate.classifications.includes(
      'FULL_FILL_LOCAL_EVIDENCE'
    );
    const terminalBroker = candidate.classifications.includes(
      'TERMINAL_BROKER_CONFIRMED'
    );
    const nonterminalBroker = candidate.classifications.includes(
      'NONTERMINAL_BROKER_CONFIRMED'
    );
    if (nonterminalBroker) {
      findings.splice(index, 1);
      continue;
    }
    if (terminalLocal || terminalBroker) {
      findings[index] = {
        ...finding,
        code: 'local_order_status_stale_terminal_broker_order',
        message: `${candidate.symbol} has terminal lifecycle evidence but remains nonterminal locally.`,
        details: {
          ...finding.details,
          classifications: candidate.classifications,
          brokerLookup: candidate.brokerLookup,
          matchedTrackedPositionId: candidate.matchedTrackedPositionId,
        },
      };
    } else {
      finding.details = {
        ...finding.details,
        classifications: candidate.classifications,
        brokerLookup: candidate.brokerLookup,
      };
    }
  }
  return findings;
}

export type RunReconciliationCheckOptions = {
  persistEvents?: boolean;
  persistAttention?: boolean;
  dedupeEvents?: boolean;
  dedupeWindowMinutes?: number;
};

export type RunReconciliationCheckResult = {
  runIdentifier: string;
  account: {
    tradingAccountId: number;
    displayName: string;
    environment: string;
  };
  findings: ReconciliationFinding[];
  eventCount: number;
  skippedDuplicateEventCount: number;
  attentionUpdateCount: number;
  legacyExitStateProjectionCount: number;
  operationalAttentionTransitionCount: number;
  persistedEvents: boolean;
  persistedAttention: boolean;
};

export class ReconciliationBrokerUnavailableError extends Error {
  tradingAccountId: number;

  constructor(tradingAccountId: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReconciliationBrokerUnavailableError';
    this.tradingAccountId = tradingAccountId;
  }
}

function buildReconciliationEventType(code: ReconciliationFindingCode) {
  return `reconciliation.${code}`;
}

export function mapReconciliationSeverity(severity: ReconciliationSeverity) {
  switch (severity) {
    case 'critical': return SystemEventSeverity.CRITICAL;
    case 'warn': return SystemEventSeverity.WARNING;
    default: return SystemEventSeverity.INFO;
  }
}

function buildReconciliationEventPayload(
  finding: ReconciliationFinding,
  account: RunReconciliationCheckResult['account'],
  runIdentifier: string
): Prisma.InputJsonValue {
  return {
    tradingAccountId: account.tradingAccountId,
    environment: account.environment,
    runIdentifier,
    code: finding.code,
    severity: finding.severity,
    symbol: finding.symbol,
    attentionCode: finding.attentionCode ?? null,
    previousAttentionState:
      finding.details?.previousAttentionRequired ?? null,
    currentAttentionState:
      finding.attentionCode && finding.severity === 'critical'
        ? 'required'
        : 'unchanged',
    details: finding.details ?? {},
  } as Prisma.InputJsonValue;
}

const DEFAULT_RECONCILIATION_EVENT_DEDUPE_WINDOW_MINUTES = 60;

function getDedupeSince(windowMinutes: number) {
  return new Date(Date.now() - windowMinutes * 60_000);
}

async function hasRecentReconciliationEvent(
  finding: ReconciliationFinding,
  tradingAccountId: number,
  dedupeSince: Date
) {
  const existing = await prisma.systemEvent.findFirst({
    where: {
      type: buildReconciliationEventType(finding.code),
      entityType: finding.entityType,
      entityId: finding.entityId,
      tradingAccountId,
      createdAt: {
        gte: dedupeSince,
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return Boolean(existing);
}

export async function reconcileTradingAccount(
  tradingAccountId: number,
  options: RunReconciliationCheckOptions = {}
): Promise<RunReconciliationCheckResult> {
  // Unlocked core. Callers must either hold the account's LIFECYCLE_MUTATION
  // barrier (for an orchestrated multi-step workflow) or use
  // reconcileTradingAccountWithLock().
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: tradingAccountId },
    select: { id: true, displayName: true, environment: true },
  });
  const runIdentifier = randomUUID();
  const [trackedPositions, localOrders, staleIntents] = await Promise.all([
    prisma.trackedPosition.findMany({
      where: {
        tradingAccountId,
        status: {
          in: ['open', 'closing'],
        },
      },
      include: {
        exitState: true,
      },
      orderBy: {
        symbol: 'asc',
      },
    }),
    prisma.brokerOrder.findMany({
      where: {
        tradingAccountId,
        status: NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
      },
      orderBy: { id: 'asc' },
    }),
    prisma.orderIntent.findMany({
      where: {
        tradingAccountId,
        status: 'submitting',
        updatedAt: { lte: new Date(Date.now() - 5 * 60_000) },
      },
      orderBy: { id: 'asc' },
    }),
  ]);
  let brokerPositions;
  let brokerOrders;
  try {
    [brokerPositions, brokerOrders] = await Promise.all([
      getNormalizedPositions(tradingAccountId, 'reconciliation_check'),
      getOpenAlpacaOrders(tradingAccountId, 'reconciliation_check'),
    ]);
  } catch (error) {
    throw new ReconciliationBrokerUnavailableError(
      tradingAccountId,
      `Reconciliation unavailable for ${account.displayName}: broker positions and open orders could not be observed.`,
      { cause: error }
    );
  }

  const findings = reconcileSnapshots({
    trackedPositions: trackedPositions.map((position) => ({
      id: position.id,
      broker: position.broker,
      symbol: position.symbol,
      status: position.status,
      side: position.side,
      qty: position.qty,
      tradingAccountId: position.tradingAccountId,
      subscriptionId: position.subscriptionId,
      tradingAccountSubscriptionId: position.tradingAccountSubscriptionId,
      configSnapshotJson: position.configSnapshotJson,
      exitState: position.exitState
        ? {
            targetUnlocked: position.exitState.targetUnlocked,
            trailClientOrderId: position.exitState.trailClientOrderId,
            trailBrokerOrderId: position.exitState.trailBrokerOrderId,
            trailOrderStatus: position.exitState.trailOrderStatus,
            attentionRequired: position.exitState.attentionRequired,
          }
        : null,
    })),
    brokerPositions: brokerPositions.map((position) => ({
      broker: position.broker ?? null,
      symbol: position.symbol,
      qty: position.qty ?? null,
      side: position.side ?? null,
    })),
    brokerOrders: brokerOrders.map((order) => ({
      broker: 'alpaca',
      id: order.id ?? null,
      client_order_id: order.client_order_id ?? null,
      symbol: order.symbol,
      side: order.side ?? null,
      qty: order.qty ?? null,
      type: order.type ?? null,
      status: order.status ?? null,
    })),
    localOrders: localOrders.map((order) => ({
      broker: order.broker,
      id: order.brokerOrderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      status: order.status,
    })),
    defaultBroker: 'alpaca',
  });
  const historicalDiagnostic = await diagnoseHistoricalOrderLifecycle({
    tradingAccountId,
    openOrders: brokerOrders,
    includeTerminalMissingPositionLinks: true,
  });
  refineHistoricalMissingOrderFindings(
    findings,
    historicalDiagnostic.candidates
  );
  for (const candidate of historicalDiagnostic.candidates) {
    if (
      candidate.side.toLowerCase() !== 'buy' ||
      !candidate.classifications.includes('FULL_FILL_LOCAL_EVIDENCE') ||
      (candidate.lifecycleLinkState.state === 'CONSISTENT' &&
        candidate.classifications.includes('POSITION_LINK_EXISTING_VALID'))
    ) continue;
    const existing = findings.find((finding) =>
      finding.code === 'local_order_status_stale_terminal_broker_order' &&
      (finding.entityId === `broker:${candidate.brokerOrderId}` || finding.entityId === `client:${candidate.clientOrderId}`)
    );
    const unresolvedComponents = [
      ...(existing ? ['STALE_ORDER_STATUS'] : []),
      ...(candidate.lifecycleLinkState.state === 'ALL_MISSING' ? ['MISSING_POSITION_LINK'] : []),
      ...(candidate.lifecycleLinkState.state === 'PARTIAL' ? ['PARTIAL_POSITION_LINK'] : []),
      ...(candidate.lifecycleLinkState.state === 'CONFLICTING' ||
      (candidate.lifecycleLinkState.state === 'CONSISTENT' && !candidate.classifications.includes('POSITION_LINK_EXISTING_VALID'))
        ? ['CONFLICTING_POSITION_LINK'] : []),
    ];
    const details = {
      unresolvedComponents,
      orderIntentId: candidate.orderIntentId,
      brokerOrderRecordId: candidate.brokerOrderRecordId,
      brokerOrderId: candidate.brokerOrderId,
      clientOrderId: candidate.clientOrderId,
      linkedBrokerActivityCount: candidate.fillEvidence.activityCount,
      classifications: candidate.classifications,
      matchedTrackedPositionId: candidate.matchedTrackedPositionId,
      candidatePositionEvaluations: candidate.candidatePositionEvaluations,
      fillEvidence: candidate.fillEvidence,
      lifecycleLinkState: candidate.lifecycleLinkState,
    };
    if (existing) {
      existing.attentionCode = 'HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE';
      existing.entityId = String(candidate.brokerOrderRecordId);
      existing.message = `Historical ${candidate.symbol} BUY BrokerOrder has full-fill evidence but retains a nonterminal local status. Its position link is unresolved.`;
      existing.details = details;
    } else {
      findings.push({
        tradingAccountId,
        code: 'historical_filled_entry_position_link_missing', severity: 'warn',
        entityType: 'brokerOrder', entityId: String(candidate.brokerOrderRecordId),
        symbol: candidate.symbol,
        attentionCode: 'HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE',
        message: `Historical ${candidate.symbol} BUY BrokerOrder is filled locally, but its position link remains unresolved.`,
        details,
      });
    }
  }
  for (const finding of findings) {
    finding.tradingAccountId = tradingAccountId;
  }
  const safelyFinalizedIntentIds = await recoverDeterministicallyAbsentStaleCloseIntents(staleIntents);
  const safelyReopenedPositionIds = new Set(
    staleIntents
      .filter((intent) => safelyFinalizedIntentIds.has(intent.id) && intent.trackedPositionId)
      .map((intent) => intent.trackedPositionId!),
  );
  for (const intent of staleIntents) {
    if (safelyFinalizedIntentIds.has(intent.id)) continue;
    findings.push({
      tradingAccountId,
      code: 'stale_submitting_intent',
      severity: 'critical',
      entityType: 'orderIntent',
      entityId: String(intent.id),
      symbol: normalizeSymbol(intent.symbol),
      message: `${intent.symbol} OrderIntent remains in submitting state and requires deterministic recovery.`,
      details: {
        clientOrderId: intent.clientOrderId,
        updatedAt: intent.updatedAt.toISOString(),
      },
    });
  }

  const persistEvents = options.persistEvents ?? true;
  const persistAttention = options.persistAttention ?? persistEvents;
  const dedupeEvents = options.dedupeEvents ?? true;
  const dedupeWindowMinutes =
    options.dedupeWindowMinutes ??
    DEFAULT_RECONCILIATION_EVENT_DEDUPE_WINDOW_MINUTES;
  const dedupeSince = getDedupeSince(dedupeWindowMinutes);

let eventCount = 0;
let skippedDuplicateEventCount = 0;
const persistedEventIds = new Map<string, number>();

  if (persistEvents) {
    for (const finding of findings) {
      if (finding.attentionCode === 'HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE') continue;
      if (dedupeEvents) {
        const duplicateExists = await hasRecentReconciliationEvent(
          finding,
          tradingAccountId,
          dedupeSince
        );

        if (duplicateExists) {
          skippedDuplicateEventCount += 1;
          continue;
        }
      }

      const event = await createSystemEvent({
        type: buildReconciliationEventType(finding.code),
        entityType: finding.entityType,
        entityId: finding.entityId,
        tradingAccountId,
        message: finding.message,
        severity: mapReconciliationSeverity(finding.severity),
        payloadJson: buildReconciliationEventPayload(
          finding,
          {
            tradingAccountId: account.id,
            displayName: account.displayName,
            environment: account.environment,
          },
          runIdentifier
        ),
      });
      persistedEventIds.set(`${finding.entityType}:${finding.entityId}:${finding.code}`, event.id);

      eventCount += 1;
    }
  }

  let legacyExitStateProjectionCount = 0;
  let operationalAttentionTransitionCount = 0;

  if (persistAttention) {
    for (const finding of findings) {
      if (
        finding.entityType !== 'trackedPosition' ||
        !finding.attentionCode ||
        finding.severity !== 'critical'
      ) {
        continue;
      }

      const trackedPositionId = Number(finding.entityId);

      if (!Number.isFinite(trackedPositionId)) {
        continue;
      }

      await markPositionExitStateAttentionRequired({
        trackedPositionId,
        code: finding.attentionCode,
        message: finding.message,
      });

      legacyExitStateProjectionCount += 1;
    }
    const projected = await projectReconciliationOperationalAttention({
      tradingAccountId,
      environment: account.environment,
      findings,
      eventIds: persistedEventIds,
      runIdentifier,
    });
    operationalAttentionTransitionCount += projected.updated + projected.resolved;
    operationalAttentionTransitionCount += await resolveClearedExitReservationAttention({
      tradingAccountId,
      environment: account.environment,
      trackedPositions: trackedPositions.map((position) => ({
        id: position.id,
        tradingAccountId: position.tradingAccountId,
        broker: position.broker,
        symbol: position.symbol,
        status: safelyReopenedPositionIds.has(position.id) ? 'open' : position.status,
        side: position.side,
        qty: position.qty,
      })),
      brokerPositions: brokerPositions.map((position) => ({
        broker: position.broker ?? null,
        symbol: position.symbol,
        qty: position.qty ?? null,
        side: position.side ?? null,
      })),
      brokerOrders: brokerOrders.map((order) => ({
        broker: 'alpaca',
        id: order.id ?? null,
        client_order_id: order.client_order_id ?? null,
        symbol: order.symbol,
        side: order.side ?? null,
        qty: order.qty ?? null,
        type: order.type ?? null,
        status: order.status ?? null,
      })),
      runIdentifier,
    });
  }

  return {
    runIdentifier,
    account: {
      tradingAccountId: account.id,
      displayName: account.displayName,
      environment: account.environment,
    },
    findings,
    eventCount,
    skippedDuplicateEventCount,
    attentionUpdateCount:
      legacyExitStateProjectionCount + operationalAttentionTransitionCount,
    legacyExitStateProjectionCount,
    operationalAttentionTransitionCount,
    persistedEvents: persistEvents,
    persistedAttention: persistAttention,
  };
}

export async function reconcileTradingAccountWithLock(
  tradingAccountId: number,
  options: RunReconciliationCheckOptions = {}
): Promise<RunReconciliationCheckResult> {
  const run = await runReconciliationAccount(tradingAccountId, options);
  if (run.outcome === 'PROCESSED') return run.value;
  if (run.outcome === 'LOCK_SKIPPED') {
    throw new Error(`Reconciliation already running for TradingAccount ${tradingAccountId}.`);
  }
  if (run.outcome === 'BACKING_OFF') {
    throw new Error(
      `Reconciliation is backing off for TradingAccount ${tradingAccountId} until ${run.backoffUntil.toISOString()}.`
    );
  }
  if (run.outcome === 'SKIPPED') {
    throw new Error(`Reconciliation skipped for TradingAccount ${tradingAccountId}.`);
  }
  throw run.error;
}

function runReconciliationAccount(
  tradingAccountId: number,
  options: RunReconciliationCheckOptions
) {
  return runTradingAccountWorkflow({
    tradingAccountId,
    workerKey: 'scheduled_reconciliation',
    lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.LIFECYCLE_MUTATION,
    execute: () => reconcileTradingAccount(tradingAccountId, options),
    classify: (result) => ({
      outcome: 'success',
      workSucceeded: true,
      summary: { findingCount: result.findings.length },
    }),
  });
}

export type ReconciliationAccountResult = {
  workflow: 'reconciliation';
  account: LifecycleAccountEligibility;
  outcome: 'PROCESSED' | 'SKIPPED' | 'CREDENTIALS_UNAVAILABLE' | 'FAILED'
    | 'LOCK_SKIPPED' | 'BACKING_OFF';
  result?: RunReconciliationCheckResult;
  error?: string;
};

export type UnattributedLifecycleFinding = {
  recordType:
    | 'TrackedPosition'
    | 'BrokerOrder'
    | 'BrokerActivity'
    | 'OrderIntent'
    | 'PositionExitState';
  id: number;
  safeIdentifier: string;
};

export async function findHistoricalUnattributedLifecycleRecords() {
  const [positions, orders, activities, intents, exitStates] = await Promise.all([
    prisma.trackedPosition.findMany({
      where: { tradingAccountId: null },
      select: { id: true, symbol: true },
      orderBy: { id: 'asc' },
      take: 100,
    }),
    prisma.brokerOrder.findMany({
      where: { tradingAccountId: null },
      select: { id: true, clientOrderId: true },
      orderBy: { id: 'asc' },
      take: 100,
    }),
    prisma.brokerActivity.findMany({
      where: { tradingAccountId: null },
      select: { id: true, activityId: true },
      orderBy: { id: 'asc' },
      take: 100,
    }),
    prisma.orderIntent.findMany({
      where: { tradingAccountId: null },
      select: { id: true, clientOrderId: true },
      orderBy: { id: 'asc' },
      take: 100,
    }),
    prisma.positionExitState.findMany({
      where: { trackedPosition: { tradingAccountId: null } },
      select: { id: true, trackedPositionId: true },
      orderBy: { id: 'asc' },
      take: 100,
    }),
  ]);

  return [
    ...positions.map((row) => ({
      recordType: 'TrackedPosition' as const,
      id: row.id,
      safeIdentifier: row.symbol,
    })),
    ...orders.map((row) => ({
      recordType: 'BrokerOrder' as const,
      id: row.id,
      safeIdentifier: row.clientOrderId,
    })),
    ...activities.map((row) => ({
      recordType: 'BrokerActivity' as const,
      id: row.id,
      safeIdentifier: row.activityId,
    })),
    ...intents.map((row) => ({
      recordType: 'OrderIntent' as const,
      id: row.id,
      safeIdentifier: row.clientOrderId ?? `intent-${row.id}`,
    })),
    ...exitStates.map((row) => ({
      recordType: 'PositionExitState' as const,
      id: row.id,
      safeIdentifier: `tracked-position-${row.trackedPositionId}`,
    })),
  ] satisfies UnattributedLifecycleFinding[];
}

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown reconciliation error.';
}

export async function reconcileEligibleTradingAccounts(
  options: RunReconciliationCheckOptions = {}
) {
  const unattributedFindings =
    await findHistoricalUnattributedLifecycleRecords();
  const accounts = await enumerateLifecycleAccounts('reconciliation');
  const results: ReconciliationAccountResult[] = [];

  for (const account of accounts) {
    if (!account.eligible) {
      const outcome =
        account.reason === 'credentials_unavailable_with_exposure'
          ? 'CREDENTIALS_UNAVAILABLE'
          : 'SKIPPED';
      results.push({ workflow: 'reconciliation', account, outcome });

      if (outcome === 'CREDENTIALS_UNAVAILABLE') {
        try {
          await createSystemEvent({
            type: 'reconciliation.credentials_unavailable_with_exposure',
            entityType: 'tradingAccount',
            entityId: account.tradingAccountId,
            tradingAccountId: account.tradingAccountId,
            severity: reconciliationExposureUnavailableSeverity(
              account.environment
            ),
            message: `Reconciliation cannot access credentials for ${account.displayName} while lifecycle exposure exists.`,
            payloadJson: {
              tradingAccountId: account.tradingAccountId,
              environment: account.environment,
              findingType: 'credentials_unavailable_with_exposure',
              activePositions: account.exposureSummary.activePositions,
              nonterminalOrders: account.exposureSummary.nonterminalOrders,
            } as Prisma.InputJsonValue,
          });
        } catch (error) {
          logger.error(
            {
              workflow: 'reconciliation',
              tradingAccountId: account.tradingAccountId,
              error: sanitizeError(error),
            },
            'Failed to persist reconciliation credentials finding.'
          );
        }
      }
      continue;
    }

    try {
      const run = await runReconciliationAccount(
        account.tradingAccountId,
        options
      );
      if (run.outcome === 'FAILED') throw run.error;
      if (run.outcome !== 'PROCESSED') {
        results.push({
          workflow: 'reconciliation',
          account,
          outcome: run.outcome,
        });
        continue;
      }
      const result = run.value;
      results.push({
        workflow: 'reconciliation',
        account,
        outcome: 'PROCESSED',
        result,
      });
    } catch (error) {
      results.push({
        workflow: 'reconciliation',
        account,
        outcome: 'FAILED',
        error: sanitizeError(error),
      });
    }
  }

  return {
    workflow: 'reconciliation' as const,
    processedAccounts: results.filter((item) => item.outcome === 'PROCESSED').length,
    failedAccounts: results.filter((item) => item.outcome === 'FAILED').length,
    credentialUnavailableAccounts: results.filter(
      (item) => item.outcome === 'CREDENTIALS_UNAVAILABLE'
    ).length,
    skippedAccounts: results.filter((item) => item.outcome === 'SKIPPED').length,
    unattributedFindings,
    results,
  };
}

export async function runReconciliationCheck(
  options: RunReconciliationCheckOptions = {}
) {
  // Legacy default-account compatibility wrapper. It still participates in
  // the shared lifecycle barrier; explicit callers should use
  // reconcileTradingAccountWithLock().
  const tradingAccountId = await resolveDefaultTradingAccountId();
  return reconcileTradingAccountWithLock(tradingAccountId, options);
}
