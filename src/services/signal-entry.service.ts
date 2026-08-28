import crypto from 'node:crypto';
import { SystemEventSeverity, type Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type {
  AssignmentEntrySignalInput,
  EntrySignalInput,
} from '../validators/signal.schema.js';
import { buildSignalEntryClientOrderId } from './client-order-id.service.js';
import { submitOrder } from './place-order.service.js';
import { createSystemEvent } from './system-event.service.js';

export type SignalEntryOutcome =
  | 'INTENT_CREATED'
  | 'BLOCKED'
  | 'SKIPPED'
  | 'DUPLICATE'
  | 'FAILED';

export type SignalEntryResult = {
  tradingAccountId: number;
  tradingAccountSubscriptionId: number;
  accountDisplayName: string;
  environment: 'PAPER' | 'LIVE';
  subscriptionKey: string;
  outcome: SignalEntryOutcome;
  code: string;
  message: string;
  orderIntentId: number | null;
};

type AccountSignal = Omit<EntrySignalInput, 'subscriptionKey'>;

export function signalEntryOutcomeSeverity(outcome: SignalEntryOutcome) {
  switch (outcome) {
    case 'INTENT_CREATED':
    case 'DUPLICATE':
    case 'SKIPPED':
      return SystemEventSeverity.INFO;
    case 'BLOCKED':
      return SystemEventSeverity.WARNING;
    case 'FAILED':
      return SystemEventSeverity.ERROR;
  }
}

function signalIdentity(signal: AccountSignal) {
  if (signal.decisionKey) return `decision:${signal.decisionKey}`;
  if (signal.runId) return `run:${signal.runId}`;
  if (signal.batchId) return `batch:${signal.batchId}`;

  return `payload:${crypto
    .createHash('sha256')
    .update(JSON.stringify(signal), 'utf8')
    .digest('hex')}`;
}

function codeForError(error: HttpError) {
  if (error.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
    const detailCode = (error.details as Record<string, unknown>).code;
    if (detailCode === 'live_entry_policy_blocked') {
      return 'LIVE_ENTRY_POLICY_BLOCKED';
    }
  }

  const message = error.message.toLowerCase();
  if (message.includes('globally disabled')) return 'SUBSCRIPTION_DISABLED';
  if (message.includes('entries are disabled')) return 'ASSIGNMENT_ENTRIES_DISABLED';
  if (message.includes('subscription') && message.includes('disabled')) {
    return 'ASSIGNMENT_DISABLED';
  }
  if (message.includes('kill switch')) return 'ACCOUNT_KILL_SWITCH_ENABLED';
  if (message.includes('trading is disabled')) return 'ACCOUNT_TRADING_DISABLED';
  if (message.includes('not operational')) return 'ACCOUNT_NOT_OPERATIONAL';
  if (message.includes('active credentials')) return 'ACCOUNT_CREDENTIALS_INACTIVE';
  if (message.includes('allocation')) return 'ALLOCATION_INELIGIBLE';
  if (error.statusCode === 409) return 'ENTRY_CONFLICT';
  if (error.statusCode === 403) return 'ENTRY_BLOCKED';
  return `HTTP_${error.statusCode}`;
}

async function recordOutcome(
  result: SignalEntryResult,
  signal: AccountSignal,
  source: string,
  identity: string
) {
  await createSystemEvent({
    type: 'signal_entry_assignment_outcome',
    entityType: 'trading_account_subscription',
    entityId: result.tradingAccountSubscriptionId,
    tradingAccountId: result.tradingAccountId,
    severity: signalEntryOutcomeSeverity(result.outcome),
    message: result.message,
    payloadJson: {
      signalIdentity: identity,
      decisionKey: signal.decisionKey ?? null,
      source,
      subscriptionKey: result.subscriptionKey,
      tradingAccountId: result.tradingAccountId,
      tradingAccountSubscriptionId: result.tradingAccountSubscriptionId,
      environment: result.environment,
      outcome: result.outcome,
      code: result.code,
      orderIntentId: result.orderIntentId,
    } satisfies Prisma.InputJsonObject,
  });
}

async function recordOutcomeBestEffort(
  result: SignalEntryResult,
  signal: AccountSignal,
  source: string,
  identity: string
) {
  try {
    await recordOutcome(result, signal, source, identity);
  } catch {
    // The order outcome remains authoritative. An audit-write failure must not
    // turn a created intent into an apparent signal failure and invite a retry.
  }
}

export async function processEntryForAccountSubscription(args: {
  tradingAccountSubscriptionId: number;
  signal: AccountSignal;
  source: string;
  idempotencyKey?: string;
}): Promise<SignalEntryResult> {
  const assignment = await prisma.tradingAccountSubscription.findUnique({
    where: { id: args.tradingAccountSubscriptionId },
    select: {
      id: true,
      subscription: { select: { key: true } },
      tradingAccount: {
        select: {
          id: true,
          displayName: true,
          environment: true,
        },
      },
    },
  });

  if (!assignment) {
    throw new HttpError(
      404,
      `TradingAccountSubscription ${args.tradingAccountSubscriptionId} was not found.`
    );
  }

  const identity = args.idempotencyKey ?? signalIdentity(args.signal);
  const clientOrderId = buildSignalEntryClientOrderId({
    signalIdentity: identity,
    tradingAccountSubscriptionId: assignment.id,
  });
  const base = {
    tradingAccountId: assignment.tradingAccount.id,
    tradingAccountSubscriptionId: assignment.id,
    accountDisplayName: assignment.tradingAccount.displayName,
    environment: assignment.tradingAccount.environment,
    subscriptionKey: assignment.subscription.key,
  };
  const existing = await prisma.orderIntent.findFirst({
    where: {
      clientOrderId,
      tradingAccountSubscriptionId: assignment.id,
    },
    select: { id: true },
  });

  if (existing) {
    const result: SignalEntryResult = {
      ...base,
      outcome: 'DUPLICATE',
      code: 'DUPLICATE_SIGNAL_ASSIGNMENT',
      message: 'This signal was already processed for the account assignment.',
      orderIntentId: existing.id,
    };
    await recordOutcomeBestEffort(result, args.signal, args.source, identity);
    return result;
  }

  try {
    const order = await submitOrder(
      {
        tradingAccountSubscriptionId: assignment.id,
        subscriptionKey: assignment.subscription.key,
        signalType: 'entry',
        orderType: 'market',
        timeInForce: 'day',
        extendedHours: false,
        signalMetadata: {
          source: args.signal.source,
          reason: args.signal.reason ?? null,
          score: args.signal.score ?? null,
          confidence: args.signal.confidence ?? null,
          runId: args.signal.runId ?? null,
          batchId: args.signal.batchId ?? null,
          decisionKey: args.signal.decisionKey ?? null,
          metadata: args.signal.metadata ?? null,
          signalIdentity: identity,
        },
      },
      { clientOrderId }
    );
    const result: SignalEntryResult = {
      ...base,
      outcome: 'INTENT_CREATED',
      code: 'INTENT_CREATED',
      message: 'Order intent created for the account assignment.',
      orderIntentId: order.intentId,
    };
    await recordOutcomeBestEffort(result, args.signal, args.source, identity);
    return result;
  } catch (error) {
    const createdIntent = await prisma.orderIntent.findFirst({
      where: { clientOrderId, tradingAccountSubscriptionId: assignment.id },
      select: { id: true },
    });
    const domainError = error instanceof HttpError;
    const result: SignalEntryResult = {
      ...base,
      outcome:
        domainError && error.statusCode >= 400 && error.statusCode < 500
          ? 'BLOCKED'
          : 'FAILED',
      code: domainError ? codeForError(error) : 'ENTRY_PROCESSING_FAILED',
      message: domainError
        ? error.message
        : 'Entry processing failed for this account assignment.',
      orderIntentId: createdIntent?.id ?? null,
    };
    await recordOutcomeBestEffort(result, args.signal, args.source, identity);
    return result;
  }
}

export async function processSubscriptionEntrySignal(signal: EntrySignalInput) {
  const subscription = await prisma.subscription.findUnique({
    where: { key: signal.subscriptionKey },
    select: {
      key: true,
      accountSubscriptions: {
        select: {
          id: true,
          tradingAccount: {
            select: {
              id: true,
              displayName: true,
              environment: true,
            },
          },
        },
        orderBy: { id: 'asc' },
      },
    },
  });

  if (!subscription) {
    throw new HttpError(
      404,
      `Subscription ${signal.subscriptionKey} was not found.`
    );
  }

  const { subscriptionKey: _subscriptionKey, ...accountSignal } = signal;
  const results: SignalEntryResult[] = [];
  for (const assignment of subscription.accountSubscriptions) {
    try {
      results.push(
        await processEntryForAccountSubscription({
          tradingAccountSubscriptionId: assignment.id,
          signal: accountSignal,
          source: signal.source,
        })
      );
    } catch {
      // The assignment was discovered from the subscription query. A concurrent
      // deletion must not prevent the remaining assignments from processing.
      results.push({
        tradingAccountId: assignment.tradingAccount.id,
        tradingAccountSubscriptionId: assignment.id,
        accountDisplayName: assignment.tradingAccount.displayName,
        environment: assignment.tradingAccount.environment,
        subscriptionKey: subscription.key,
        outcome: 'FAILED',
        code: 'ASSIGNMENT_PROCESSING_FAILED',
        message: 'Entry processing failed for this account assignment.',
        orderIntentId: null,
      });
    }
  }

  return { subscriptionKey: subscription.key, results };
}

export async function processTargetedEntrySignal(
  signal: AssignmentEntrySignalInput
) {
  const {
    tradingAccountSubscriptionId,
    ...accountSignal
  } = signal;
  return processEntryForAccountSubscription({
    tradingAccountSubscriptionId,
    signal: accountSignal,
    source: signal.source,
  });
}
