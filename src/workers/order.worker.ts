import type { Prisma } from '@prisma/client';
import { logger } from '../config/logger.js';

import { AlpacaRateLimitDeferredError } from '../errors/alpaca-rate-limit-deferred-error.js';
import { prisma } from '../db/prisma.js';
import { getNormalizedOpenOrders } from '../services/orders.service.js';
import { placeOrderSchema } from '../validators/place-order.schema.js';
import type { ResolvedPlaceOrderInput } from '../validators/place-order.schema.js';
import {
  submitOrderToBroker,
  type BrokerOrderSubmissionInput,
} from '../services/place-order.service.js';
import { createSystemEvent } from '../services/system-event.service.js';
import { syncTrailingStopOrderStatus } from '../services/position-exit-state.service.js';
import {
  adaptivePollingCoordinator,
  type AdaptivePollingDecision,
} from '../services/adaptive-polling.service.js';
import { linkEntryDecisionToBrokerOrder } from '../services/entry-decision.service.js';
import {
  enumerateLifecycleAccounts,
  type LifecycleAccountEligibility,
} from '../services/lifecycle-account-eligibility.service.js';
import { resolveDefaultTradingAccountId } from '../services/trading-account.service.js';
import { runTradingAccountWorkflow } from '../services/trading-account-workflow-runner.service.js';
import { ACCOUNT_WORKFLOW_LOCK_FAMILIES } from '../services/trading-account-workflow-lock.service.js';
import {
  evaluateOrderRisk,
  logRiskGateBlockedOrder,
} from '../services/risk-gate.service.js';
import { getSizingEstimatedNotional } from '../services/trading-account-entry-risk-usage.service.js';
import { recordOrderIntentRiskEvaluation } from '../services/order-audit.service.js';
import { resolveSubscriptionOrderInput } from '../services/subscription.service.js';
import { getAlpacaOrderByClientOrderId } from '../integrations/alpaca/orders.adapter.js';

export type SubmittedOrderSyncResult = {
  found: number;
  polled: boolean;
  synced: number;
  failed: number;
  failures: Array<{
    orderIntentId: number;
    brokerOrderRecordId: number | null;
    error: string;
  }>;
  skipped: boolean;
  skipReason:
    | 'no_local_submitted_orders'
    | 'adaptive_poll_not_due'
    | 'rate_limited'
    | null;
  deferred: boolean;
  backoffUntil?: string | null;
  mode?: AdaptivePollingDecision['mode'];
  effectiveIntervalMs?: number | null;
  nextDueAt?: string | null;
};

export type LifecycleCoordinatorOutcome =
  | 'PROCESSED'
  | 'SKIPPED'
  | 'LOCK_SKIPPED'
  | 'BACKING_OFF'
  | 'CREDENTIALS_UNAVAILABLE'
  | 'FAILED';

export type SubmittedOrderAccountResult = {
  workflow: 'submitted_orders';
  account: LifecycleAccountEligibility;
  outcome: LifecycleCoordinatorOutcome;
  result?: SubmittedOrderSyncResult;
  error?: string;
};

const SUBMITTED_ORDER_BATCH_LIMIT_PER_ACCOUNT = 10;
export const PENDING_ORDER_BATCH_LIMIT_PER_ACCOUNT = 5;
export const STALE_SUBMITTING_INTENT_THRESHOLD_MS = 5 * 60_000;

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown worker error.';
}

function isExitIntent(intent: { rawRequestJson: Prisma.JsonValue }) {
  const raw = intent.rawRequestJson;
  return (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    raw.signalType === 'exit'
  );
}

function getRecordedDeliveryClassification(blockReason: string | null) {
  const match = blockReason?.match(
    /BROKER_WRITE_DELIVERY:(NOT_SENT_RETRYABLE|NOT_SENT_BLOCKED|BROKER_REJECTED|DELIVERY_UNCERTAIN)/
  );
  return match?.[1] ?? null;
}

export async function recoverStaleSubmittingIntentsForAccount(
  tradingAccountId: number,
  now = new Date()
) {
  const intents = await prisma.orderIntent.findMany({
    where: {
      tradingAccountId,
      status: 'submitting',
      updatedAt: {
        lte: new Date(now.getTime() - STALE_SUBMITTING_INTENT_THRESHOLD_MS),
      },
    },
    include: { brokerOrders: true },
    orderBy: { updatedAt: 'asc' },
    take: 5,
  });
  let linked = 0;
  let retryable = 0;
  let retained = 0;

  for (const intent of intents) {
    if (!intent.clientOrderId) {
      retained += 1;
      continue;
    }

    const persisted = intent.brokerOrders[0];
    if (persisted) {
      await prisma.orderIntent.updateMany({
        where: { id: intent.id, status: 'submitting' },
        data: { status: 'submitted', blockReason: null },
      });
      linked += 1;
      continue;
    }

    const brokerOrder = await getAlpacaOrderByClientOrderId(
      tradingAccountId,
      intent.clientOrderId,
      'pending_order_idempotency_check'
    );

    if (brokerOrder) {
      const security = await prisma.security.findUniqueOrThrow({
        where: { symbol: brokerOrder.symbol.toUpperCase() },
        select: { id: true },
      });
      await prisma.$transaction(async (tx) => {
        const existing = await tx.brokerOrder.findFirst({
          where: {
            broker: 'alpaca',
            brokerOrderId: brokerOrder.id,
            tradingAccountId,
          },
        });
        if (!existing) {
          await tx.brokerOrder.create({
            data: {
              orderIntentId: intent.id,
              broker: 'alpaca',
              brokerOrderId: brokerOrder.id,
              clientOrderId: brokerOrder.client_order_id,
              symbol: brokerOrder.symbol,
              side: brokerOrder.side,
              status: brokerOrder.status,
              tradingAccountId,
              trackedPositionId: intent.trackedPositionId,
              securityId: security.id,
              rawBrokerJson: brokerOrder as unknown as Prisma.InputJsonValue,
            },
          });
        }
        await tx.orderIntent.updateMany({
          where: { id: intent.id, status: 'submitting' },
          data: { status: 'submitted', blockReason: null },
        });
      });
      await createSystemEvent({
        type: 'order.submission_recovered',
        entityType: 'orderIntent',
        entityId: intent.id,
        tradingAccountId,
        payloadJson: {
          clientOrderId: intent.clientOrderId,
          brokerOrderId: brokerOrder.id,
          recovery: 'broker_order_materialized',
        } as Prisma.InputJsonValue,
      });
      linked += 1;
      continue;
    }

    if (isExitIntent(intent)) {
      const classification = getRecordedDeliveryClassification(
        intent.blockReason
      );
      if (
        classification === 'NOT_SENT_RETRYABLE' ||
        classification === 'NOT_SENT_BLOCKED' ||
        classification === 'BROKER_REJECTED'
      ) {
        await prisma.$transaction(async (tx) => {
          await tx.orderIntent.updateMany({
            where: { id: intent.id, status: 'submitting' },
            data: {
              status:
                classification === 'NOT_SENT_BLOCKED' ? 'blocked' : 'failed',
            },
          });
          if (intent.trackedPositionId !== null) {
            await tx.trackedPosition.updateMany({
              where: { id: intent.trackedPositionId, status: 'closing' },
              data: { status: 'open', lastSyncedAt: new Date() },
            });
          }
        });
        retryable += 1;
        continue;
      }

      if (!intent.blockReason?.includes('RECOVERY_DEFERRED_EVENT_RECORDED')) {
        await createSystemEvent({
          type: 'order.submission_recovery_deferred',
          entityType: 'orderIntent',
          entityId: intent.id,
          tradingAccountId,
          payloadJson: {
            clientOrderId: intent.clientOrderId,
            deliveryClassification:
              classification ?? 'DELIVERY_UNCERTAIN',
            recovery: 'exit_order_not_requeued',
          } as Prisma.InputJsonValue,
        });
        await prisma.orderIntent.updateMany({
          where: { id: intent.id, status: 'submitting' },
          data: {
            blockReason: `${intent.blockReason ?? 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN'}:RECOVERY_DEFERRED_EVENT_RECORDED`,
          },
        });
      }
      retained += 1;
      continue;
    }

    const reset = await prisma.orderIntent.updateMany({
      where: { id: intent.id, status: 'submitting' },
      data: {
        status: 'pending',
        blockReason: 'Recovered stale submitting intent after broker lookup found no order.',
      },
    });
    if (reset.count === 1) {
      await createSystemEvent({
        type: 'order.submission_retry_scheduled',
        entityType: 'orderIntent',
        entityId: intent.id,
        tradingAccountId,
        payloadJson: {
          clientOrderId: intent.clientOrderId,
          recovery: 'broker_order_absent_entry_requeued',
        } as Prisma.InputJsonValue,
      });
      retryable += 1;
    }
  }

  return { found: intents.length, linked, retryable, retained };
}

export async function recoverStaleSubmittingIntents() {
  const accounts = await enumerateLifecycleAccounts('submitted_orders');
  const results = [];
  for (const account of accounts) {
    if (!account.eligible) {
      results.push({
        account,
        outcome:
          account.reason === 'credentials_unavailable_with_exposure'
            ? 'CREDENTIALS_UNAVAILABLE' as const
            : 'SKIPPED' as const,
      });
      continue;
    }
    try {
      const run = await runTradingAccountWorkflow({
        tradingAccountId: account.tradingAccountId,
        workerKey: 'pending_order_processing',
        lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.ORDER_LIFECYCLE,
        execute: () => recoverStaleSubmittingIntentsForAccount(account.tradingAccountId),
      });
      if (run.outcome === 'FAILED') {
        if (run.value !== undefined) {
          results.push({ account, outcome: 'FAILED' as const, result: run.value });
          continue;
        }
        throw run.error;
      }
      results.push({
        account,
        outcome: run.outcome,
        ...(run.outcome === 'PROCESSED' ? { result: run.value } : {}),
      });
    } catch (error) {
      results.push({
        account,
        outcome: 'FAILED' as const,
        error: sanitizeError(error),
      });
    }
  }
  return { workflow: 'stale_submitting_recovery' as const, results };
}

function isEntryOrder(input: BrokerOrderSubmissionInput): boolean {
  return input.side === 'buy' && (input.signalType ?? 'entry') === 'entry';
}

export async function processPendingOrdersForAccount(
  tradingAccountId: number
) {
  const pending = await prisma.orderIntent.findMany({
    where: { status: 'pending', tradingAccountId },
    take: PENDING_ORDER_BATCH_LIMIT_PER_ACCOUNT,
    orderBy: { createdAt: 'asc' },
  });

  if (pending.length > 0) {
    logger.trace({ pendingOrders: pending.length }, 'Order worker found pending orders.');
  }

  let claimed = 0;
  let submitted = 0;
  let blocked = 0;
  let failed = 0;

  for (const intent of pending) {
    logger.trace({ orderIntentId: intent.id }, 'Order worker processing intent.');

    try {
      const claimResult = await prisma.orderIntent.updateMany({
        where: {
          id: intent.id,
          status: 'pending',
        },
        data: {
          status: 'submitting',
        },
      });

      if (claimResult.count !== 1) {
        logger.trace({ orderIntentId: intent.id }, 'Order intent was already claimed.');
        continue;
      }

      claimed += 1;

      if (!intent.clientOrderId) {
        throw new Error(
          `OrderIntent ${intent.id} is missing clientOrderId. Cannot submit safely.`
        );
      }
      if (
        intent.tradingAccountId === null ||
        intent.tradingAccountSubscriptionId === null
      ) {
        throw new Error(
          `OrderIntent ${intent.id} is missing explicit trading account assignment identity.`
        );
      }

      const rawInput = placeOrderSchema.parse(intent.rawRequestJson);
      const currentAssignmentInput = await resolveSubscriptionOrderInput(rawInput);
      if (
        currentAssignmentInput.tradingAccountId !== intent.tradingAccountId ||
        currentAssignmentInput.tradingAccountSubscriptionId !==
          intent.tradingAccountSubscriptionId
      ) {
        throw new Error(
          `OrderIntent ${intent.id} account assignment no longer matches its recorded routing identity.`
        );
      }

      const resolvedInput: BrokerOrderSubmissionInput = {
        ...rawInput,
        symbol: intent.symbol,
        side: intent.side as 'buy' | 'sell',
        orderType: intent.orderType as 'market' | 'limit',
        timeInForce: intent.timeInForce as 'day' | 'gtc',
        tradingAccountId: intent.tradingAccountId,
        tradingAccountSubscriptionId:
          intent.tradingAccountSubscriptionId,
        clientOrderId: intent.clientOrderId,
      };

      if (intent.subscriptionId !== null) {
        resolvedInput.subscriptionId = intent.subscriptionId;
      }

      if (isEntryOrder(resolvedInput)) {
        const requestedNotionalOverride = getSizingEstimatedNotional(
          intent.rawRequestJson
        );
        const riskResult = await evaluateOrderRisk(resolvedInput, {
          tradingAccountId: intent.tradingAccountId,
          excludeOrderIntentId: intent.id,
          ...(requestedNotionalOverride !== null
            ? { requestedNotionalOverride }
            : {}),
        });
        await recordOrderIntentRiskEvaluation({
          orderIntentId: intent.id,
          allowed: riskResult.allowed,
          reason: riskResult.allowed ? null : riskResult.reason,
          details: riskResult.details,
        });

        if (!riskResult.allowed) {
          await prisma.orderIntent.update({
            where: { id: intent.id },
            data: {
              status: 'blocked',
              blockReason: riskResult.reason,
            },
          });

          await logRiskGateBlockedOrder({
            orderIntentId: intent.id,
            tradingAccountId: intent.tradingAccountId,
            input: resolvedInput,
            result: riskResult,
          });

          logger.trace({ orderIntentId: intent.id, reason: riskResult.reason },
            'Order intent blocked by worker-time risk recheck.');

          blocked += 1;
          continue;
        }
      }

      const result = await submitOrderToBroker(resolvedInput, {
        tradingAccountId: intent.tradingAccountId,
      });
      const brokerOrder = result.order;

      const existingBrokerOrderRecord = await prisma.brokerOrder.findFirst({
        where: {
          broker: 'alpaca',
          brokerOrderId: brokerOrder.id,
          tradingAccountId: intent.tradingAccountId,
        },
      });

      if (existingBrokerOrderRecord) {
        await linkEntryDecisionToBrokerOrder({
          orderIntentId: intent.id,
          brokerOrderRecordId: existingBrokerOrderRecord.id,
          tradingAccountId: intent.tradingAccountId,
        });

        await prisma.orderIntent.update({
          where: { id: intent.id },
          data: {
            status: 'submitted',
          },
        });

        logger.trace({ orderIntentId: intent.id, brokerOrderId: brokerOrder.id },
          'Order intent already has a broker order.');

        submitted += 1;
        continue;
      }

      await prisma.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: 'submitted',
          brokerOrders: {
            create: {
              broker: 'alpaca',
              brokerOrderId: brokerOrder.id,
              clientOrderId: brokerOrder.client_order_id,
              symbol: brokerOrder.symbol,
              side: brokerOrder.side,
              status: brokerOrder.status,
              ...(intent.tradingAccountId !== null
                ? {
                    tradingAccount: {
                      connect: { id: intent.tradingAccountId },
                    },
                  }
                : {}),
              ...(intent.trackedPositionId !== null
                ? {
                    trackedPosition: {
                      connect: { id: intent.trackedPositionId },
                    },
                  }
                : {}),
              security: {
                connect: { symbol: brokerOrder.symbol.toUpperCase() },
              },
              rawBrokerJson: brokerOrder as unknown as Prisma.InputJsonValue,
            },
          },
        },
      });

      const createdBrokerOrderRecord = await prisma.brokerOrder.findFirst({
        where: {
          broker: 'alpaca',
          brokerOrderId: brokerOrder.id,
          tradingAccountId: intent.tradingAccountId,
        },
      });

      if (createdBrokerOrderRecord) {
        await linkEntryDecisionToBrokerOrder({
          orderIntentId: intent.id,
          brokerOrderRecordId: createdBrokerOrderRecord.id,
          tradingAccountId: intent.tradingAccountId,
        });
      }

      logger.trace({ orderIntentId: intent.id }, 'Order intent submitted.');
      submitted += 1;
    } catch (error) {
      await prisma.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: 'failed',
          blockReason:
            error instanceof Error ? error.message : 'Unknown worker error.',
        },
      });

      logger.trace({ orderIntentId: intent.id, error },
        'Order intent broker submission failed before account health persistence.');
      failed += 1;
    }
  }

  return {
    found: pending.length,
    claimed,
    submitted,
    blocked,
    failed,
  };
}

export async function processPendingOrders() {
  const accounts = await enumerateLifecycleAccounts('pending_submissions');
  const results = [];

  for (const account of accounts) {
    if (!account.eligible) {
      const outcome =
        account.reason === 'credentials_unavailable_with_exposure'
          ? 'CREDENTIALS_UNAVAILABLE' as const
          : 'SKIPPED' as const;
      results.push({ account, outcome });
      continue;
    }

    try {
      const run = await runTradingAccountWorkflow({
        tradingAccountId: account.tradingAccountId,
        workerKey: 'pending_order_processing',
        lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.ORDER_LIFECYCLE,
        execute: () => processPendingOrdersForAccount(account.tradingAccountId),
        classify: (result) => result.failed > 0
          ? {
              outcome: 'failure',
              error: new Error(`${result.failed} pending order submission(s) failed.`),
              errorCode: 'PENDING_ORDER_ITEM_FAILURE',
              summary: result,
            }
          : { outcome: 'success', workSucceeded: result.submitted > 0, summary: result },
      });
      if (run.outcome === 'FAILED') {
        if (run.value !== undefined) {
          results.push({ account, outcome: 'FAILED' as const, result: run.value });
          continue;
        }
        throw run.error;
      }
      if (run.outcome !== 'PROCESSED') {
        results.push({ account, outcome: run.outcome });
        continue;
      }
      const result = run.value;
      results.push({
        account,
        outcome: result.failed > 0 ? 'FAILED' as const : 'PROCESSED' as const,
        result,
      });
    } catch (error) {
      const message = sanitizeError(error);
      results.push({
        account,
        outcome: 'FAILED' as const,
        error: message,
      });
      logger.trace({
        workflow: 'pending_submissions',
        tradingAccountId: account.tradingAccountId,
        displayName: account.displayName,
        environment: account.environment,
        outcome: 'FAILED',
        error: message,
      }, 'Pending submission account failure captured for account health.');
    }
  }

  const accountResults = results.flatMap((item) =>
    'result' in item && item.result ? [item.result] : []
  );

  return {
    workflow: 'pending_submissions' as const,
    processedAccounts: results.filter((item) => item.outcome === 'PROCESSED')
      .length,
    failedAccounts: results.filter((item) => item.outcome === 'FAILED').length,
    credentialUnavailableAccounts: results.filter(
      (item) => item.outcome === 'CREDENTIALS_UNAVAILABLE'
    ).length,
    skippedAccounts: results.filter((item) => item.outcome === 'SKIPPED')
      .length,
    intentsFound: accountResults.reduce((sum, item) => sum + item.found, 0),
    intentsClaimed: accountResults.reduce((sum, item) => sum + item.claimed, 0),
    intentsSubmitted: accountResults.reduce(
      (sum, item) => sum + item.submitted,
      0
    ),
    intentsBlocked: accountResults.reduce((sum, item) => sum + item.blocked, 0),
    intentsFailed: accountResults.reduce((sum, item) => sum + item.failed, 0),
    results,
  };
}

export async function syncSubmittedOrdersForAccount(tradingAccountId: number) {
  const submittedIntents = await prisma.orderIntent.findMany({
    where: {
      status: 'submitted',
      tradingAccountId,
    },
    include: {
      brokerOrders: true
    },
    take: SUBMITTED_ORDER_BATCH_LIMIT_PER_ACCOUNT,
    orderBy: { createdAt: 'asc' },
  });

  if (submittedIntents.length === 0) {
    return {
      found: 0,
      polled: false,
      synced: 0,
      failed: 0,
      failures: [],
      skipped: true,
      skipReason: 'no_local_submitted_orders' as const,
      deferred: false,
    } satisfies SubmittedOrderSyncResult;
  }

  const decision = await adaptivePollingCoordinator.getDecision(
    tradingAccountId,
    'submitted_order_sync'
  );

  if (!decision.due) {
    return {
      found: submittedIntents.length,
      polled: false,
      synced: 0,
      failed: 0,
      failures: [],
      skipped: true,
      skipReason:
        decision.reason === 'rate_limit_backoff'
          ? 'rate_limited'
          : 'adaptive_poll_not_due',
      deferred: false,
      mode: decision.mode,
      effectiveIntervalMs: decision.effectiveIntervalMs,
      nextDueAt: decision.nextDueAt?.toISOString() ?? null,
    } satisfies SubmittedOrderSyncResult;
  }

  let openOrders: Awaited<ReturnType<typeof getNormalizedOpenOrders>>;

  try {
    adaptivePollingCoordinator.recordAttempt(
      'submitted_order_sync',
      tradingAccountId,
      new Date()
    );
    openOrders = await getNormalizedOpenOrders(
      tradingAccountId,
      'submitted_order_sync'
    );
  } catch (error) {
    if (error instanceof AlpacaRateLimitDeferredError) {
      adaptivePollingCoordinator.recordRateLimitDeferred(
        'submitted_order_sync',
        tradingAccountId,
        error.backoffUntil,
        new Date()
      );

      return {
        found: submittedIntents.length,
        polled: false,
        synced: 0,
        failed: 0,
        failures: [],
        skipped: true,
        skipReason: 'rate_limited' as const,
        deferred: true,
        backoffUntil: error.backoffUntil?.toISOString() ?? null,
        mode: decision.mode,
        effectiveIntervalMs: decision.effectiveIntervalMs,
        nextDueAt: error.backoffUntil?.toISOString() ?? null,
      } satisfies SubmittedOrderSyncResult;
    }

    adaptivePollingCoordinator.recordFailure(
      'submitted_order_sync',
      tradingAccountId,
      new Date()
    );
    logger.trace({ error },
      'Alpaca open-order fetch failed before account health persistence.');
    throw error;
  }

  const openOrdersByBrokerOrderId = new Map(
    openOrders.map((order) => [order.id, order])
  );

  let synced = 0;
  const failures: SubmittedOrderSyncResult['failures'] = [];

  for (const intent of submittedIntents) {
    try {
      const brokerOrder = intent.brokerOrders[0];

      if (!brokerOrder) {
        continue;
      }

      const alpacaOrder = openOrdersByBrokerOrderId.get(brokerOrder.brokerOrderId);

      if (!alpacaOrder) {
        continue;
      }

      const previousStatus = brokerOrder.status;
      const nextStatus = alpacaOrder.status;

      await syncTrailingStopOrderStatus({
        tradingAccountId,
        clientOrderId: brokerOrder.clientOrderId,
        brokerOrderId: brokerOrder.brokerOrderId,
        orderStatus: nextStatus,
        rawBrokerJson: {
          brokerOrderId: brokerOrder.brokerOrderId,
          clientOrderId: brokerOrder.clientOrderId,
          previousStatus: brokerOrder.status,
          nextStatus,
          matchedOpenOrder: alpacaOrder.status ?? null,
        } as Prisma.InputJsonValue,
      });

      if (previousStatus !== nextStatus) {
        const updated = await prisma.brokerOrder.updateMany({
          where: {
            id: brokerOrder.id,
            status: previousStatus,
          },
          data: {
            status: nextStatus,
            rawBrokerJson: alpacaOrder as unknown as Prisma.InputJsonValue,
          },
        });

        if (updated.count !== 1) {
          logger.trace({ brokerOrderId: brokerOrder.id },
            'Broker order status was already updated.');

          continue;
        }

        await prisma.orderIntent.update({
          where: { id: brokerOrder.orderIntentId },
          data: {
            status: nextStatus,
          },
        });

        await createSystemEvent({
          type: `order.${nextStatus}`,
          entityType: 'brokerOrder',
          entityId: brokerOrder.id,
          tradingAccountId: brokerOrder.tradingAccountId,
          payloadJson: {
            orderIntentId: brokerOrder.orderIntentId,
            brokerOrderId: brokerOrder.brokerOrderId,
            symbol: brokerOrder.symbol,
            side: brokerOrder.side,
            previousStatus,
            nextStatus,
          } as Prisma.InputJsonValue,
        });

        logger.trace({ brokerOrderId: brokerOrder.id, previousStatus, nextStatus },
          'Broker order status changed.');
        synced += 1;
      }
    } catch (error) {
      const brokerOrder = intent.brokerOrders[0];
      const message = sanitizeError(error);
      failures.push({
        orderIntentId: intent.id,
        brokerOrderRecordId: brokerOrder?.id ?? null,
        error: message,
      });
      logger.trace({
        workflow: 'submitted_orders',
        tradingAccountId,
        orderIntentId: intent.id,
        brokerOrderRecordId: brokerOrder?.id ?? null,
        outcome: 'FAILED',
        error: message,
      }, 'Submitted-order item failure captured for account health.');
    }
  }

  const completedAt = new Date();
  if (failures.length > 0) {
    adaptivePollingCoordinator.recordFailure(
      'submitted_order_sync',
      tradingAccountId,
      completedAt
    );
  } else {
    adaptivePollingCoordinator.recordSuccess(
      'submitted_order_sync',
      tradingAccountId,
      completedAt,
      decision.effectiveIntervalMs
    );
  }

  return {
    found: submittedIntents.length,
    polled: true,
    synced,
    failed: failures.length,
    failures,
    deferred: false,
    skipped: false,
    skipReason: null,
    mode: decision.mode,
    effectiveIntervalMs: decision.effectiveIntervalMs,
    nextDueAt:
      decision.effectiveIntervalMs === null
        ? null
        : new Date(completedAt.getTime() + decision.effectiveIntervalMs).toISOString(),
  } satisfies SubmittedOrderSyncResult;
}

export async function syncSubmittedOrdersAcrossAccounts() {
  const accounts = await enumerateLifecycleAccounts('submitted_orders');
  const results: SubmittedOrderAccountResult[] = [];

  for (const account of accounts) {
    if (!account.eligible) {
      const outcome =
        account.reason === 'credentials_unavailable_with_exposure'
          ? 'CREDENTIALS_UNAVAILABLE'
          : 'SKIPPED';
      results.push({ workflow: 'submitted_orders', account, outcome });
      continue;
    }

    try {
      const run = await runTradingAccountWorkflow({
        tradingAccountId: account.tradingAccountId,
        workerKey: 'submitted_order_sync',
        lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.ORDER_LIFECYCLE,
        execute: () => syncSubmittedOrdersForAccount(account.tradingAccountId),
        classify: (result) => result.failed > 0
          ? {
              outcome: 'failure',
              error: new Error(`${result.failed} submitted order synchronization(s) failed.`),
              errorCode: 'SUBMITTED_ORDER_ITEM_FAILURE',
              summary: result,
            }
          : result.skipped
            ? { outcome: 'skipped', summary: result }
            : { outcome: 'success', workSucceeded: result.synced > 0, summary: result },
      });
      if (run.outcome === 'FAILED') {
        if (run.value !== undefined) {
          results.push({
            workflow: 'submitted_orders', account, outcome: 'FAILED', result: run.value,
          });
          continue;
        }
        throw run.error;
      }
      if (run.outcome !== 'PROCESSED') {
        results.push({ workflow: 'submitted_orders', account, outcome: run.outcome });
        continue;
      }
      const result = run.value;
      results.push({
        workflow: 'submitted_orders',
        account,
        outcome:
          result.failed > 0
            ? 'FAILED'
            : result.skipped
              ? 'SKIPPED'
              : 'PROCESSED',
        result,
      });
    } catch (error) {
      const message = sanitizeError(error);
      results.push({
        workflow: 'submitted_orders',
        account,
        outcome: 'FAILED',
        error: message,
      });
      logger.trace({
        workflow: 'submitted_orders',
        tradingAccountId: account.tradingAccountId,
        displayName: account.displayName,
        environment: account.environment,
        outcome: 'FAILED',
        error: message,
      }, 'Submitted-order account failure captured for account health.');
    }
  }

  return {
    workflow: 'submitted_orders' as const,
    processedAccounts: results.filter((item) => item.outcome === 'PROCESSED')
      .length,
    failedAccounts: results.filter((item) => item.outcome === 'FAILED').length,
    results,
  };
}

// Compatibility wrapper for explicit legacy/manual callers. Scheduled worker
// execution uses syncSubmittedOrdersAcrossAccounts.
export async function syncSubmittedOrders() {
  return syncSubmittedOrdersForAccount(await resolveDefaultTradingAccountId());
}
