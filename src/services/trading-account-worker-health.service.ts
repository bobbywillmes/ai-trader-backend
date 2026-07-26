import type { Prisma, TradingAccountWorkerHealthState } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { createSystemEvent } from './system-event.service.js';
import { getWorkerDefinition, type WorkerKey } from '../workers/worker-health.definitions.js';

export type AccountWorkerStatus =
  | 'HEALTHY' | 'DORMANT' | 'STARTING' | 'DEGRADED'
  | 'DELAYED' | 'STALE' | 'FAILING' | 'BACKING_OFF';

const MAX_ERROR_LENGTH = 500;
const TRANSITION_EVENT_STATUSES = new Set<AccountWorkerStatus>(['FAILING', 'STALE']);

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
}

export function deriveTradingAccountWorkerStatus(
  state: Pick<TradingAccountWorkerHealthState,
    'applicable' | 'eligible' | 'currentRunStartedAt' | 'lastSucceededAt' |
    'lastFailedAt' | 'consecutiveFailures' | 'backoffUntil' | 'lastLockSkippedAt'>,
  definition: ReturnType<typeof getWorkerDefinition>,
  now = new Date()
): AccountWorkerStatus {
  if (!state.applicable) return 'DORMANT';
  if (state.backoffUntil && state.backoffUntil > now) return 'BACKING_OFF';
  if (state.consecutiveFailures > 0) return 'FAILING';
  if (state.currentRunStartedAt &&
      now.getTime() - state.currentRunStartedAt.getTime() > definition.maxRunDurationMs) return 'DEGRADED';
  if (!state.lastSucceededAt) {
    if (state.lastLockSkippedAt &&
        now.getTime() - state.lastLockSkippedAt.getTime() > definition.staleAfterMs) return 'STALE';
    return 'STARTING';
  }
  const age = now.getTime() - state.lastSucceededAt.getTime();
  if (age > definition.staleAfterMs) return 'STALE';
  if (age > definition.delayedAfterMs) return 'DELAYED';
  return 'HEALTHY';
}

async function emitTransition(args: {
  state: TradingAccountWorkerHealthState;
  previousStatus: AccountWorkerStatus;
  nextStatus: AccountWorkerStatus;
  reason: string | null;
}) {
  if (args.previousStatus === args.nextStatus) return;
  const account = await prisma.tradingAccount.findUnique({
    where: { id: args.state.tradingAccountId },
    select: { displayName: true, environment: true },
  });
  if (!account) return;
  const recovered = TRANSITION_EVENT_STATUSES.has(args.previousStatus) &&
    !TRANSITION_EVENT_STATUSES.has(args.nextStatus);
  if (!recovered && !TRANSITION_EVENT_STATUSES.has(args.nextStatus)) return;
  await createSystemEvent({
    type: recovered ? 'account_worker_health.recovered' :
      args.nextStatus === 'STALE' ? 'account_worker_health.stale' : 'account_worker_health.failing',
    entityType: 'tradingAccountWorker',
    entityId: `${args.state.tradingAccountId}:${args.state.workerKey}`,
    tradingAccountId: args.state.tradingAccountId,
    message: `${account.displayName} ${args.state.workerKey} changed from ${args.previousStatus} to ${args.nextStatus}.`,
    payloadJson: {
      tradingAccountId: args.state.tradingAccountId,
      workerKey: args.state.workerKey,
      displayName: account.displayName,
      environment: account.environment,
      previousStatus: args.previousStatus,
      nextStatus: args.nextStatus,
      reason: args.reason,
      processInstanceId: args.state.processInstanceId,
      consecutiveFailures: args.state.consecutiveFailures,
      lastSucceededAt: args.state.lastSucceededAt,
      lastFailedAt: args.state.lastFailedAt,
    },
  });
}

export async function recordTradingAccountWorkerAttempt(args: {
  tradingAccountId: number;
  workerKey: WorkerKey;
  processInstanceId: string;
  outcome: 'success' | 'failure' | 'dormant' | 'lock_skipped' | 'backoff_skipped';
  applicable?: boolean;
  eligible?: boolean;
  eligibilityReason?: string | null;
  workSucceeded?: boolean;
  error?: unknown;
  errorCode?: string | null;
  summary?: Prisma.InputJsonValue;
  backoffUntil?: Date | null;
  startedAt?: Date;
}) {
  const definition = getWorkerDefinition(args.workerKey);
  const now = new Date();
  const previous = await prisma.tradingAccountWorkerHealthState.findUnique({
    where: { tradingAccountId_workerKey: {
      tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
    } },
  });
  const previousStatus = previous
    ? deriveTradingAccountWorkerStatus(previous, definition, now) : 'STARTING';
  const failure = args.outcome === 'failure';
  const success = args.outcome === 'success' || args.outcome === 'dormant';
  const skip = args.outcome.endsWith('skipped') || args.outcome === 'dormant';
  const state = await prisma.tradingAccountWorkerHealthState.upsert({
    where: { tradingAccountId_workerKey: {
      tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
    } },
    create: {
      tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
      processInstanceId: args.processInstanceId, expectedIntervalMs: definition.expectedIntervalMs,
      applicable: args.applicable ?? args.outcome !== 'dormant',
      eligible: args.eligible ?? true,
      ...(args.eligibilityReason !== undefined ? { eligibilityReason: args.eligibilityReason } : {}),
      lastTickStartedAt: args.startedAt ?? now, lastTickCompletedAt: now,
      lastSucceededAt: success ? now : null, lastWorkSucceededAt: args.workSucceeded ? now : null,
      lastFailedAt: failure ? now : null, lastOutcome: args.outcome,
      lastSkipReason: skip ? args.outcome : null, totalRuns: 1,
      totalFailures: failure ? 1 : 0, totalSkips: skip ? 1 : 0,
      totalLockSkips: args.outcome === 'lock_skipped' ? 1 : 0,
      lastLockSkippedAt: args.outcome === 'lock_skipped' ? now : null,
      consecutiveFailures: failure ? 1 : 0, lastError: failure ? safeError(args.error) : null,
      lastErrorCode: failure ? (args.errorCode ?? null) : null, lastErrorAt: failure ? now : null,
      ...(args.backoffUntil !== undefined ? { backoffUntil: args.backoffUntil } : {}),
      ...(args.summary !== undefined ? { lastSummaryJson: args.summary } : {}),
      lastDurationMs: Math.max(0, now.getTime() - (args.startedAt ?? now).getTime()),
    },
    update: {
      processInstanceId: args.processInstanceId, currentRunStartedAt: null,
      applicable: args.applicable ?? args.outcome !== 'dormant',
      eligible: args.eligible ?? true,
      ...(args.eligibilityReason !== undefined ? { eligibilityReason: args.eligibilityReason } : {}),
      lastTickStartedAt: args.startedAt ?? now, lastTickCompletedAt: now,
      ...(success ? { lastSucceededAt: now, consecutiveFailures: 0, backoffUntil: null,
        lastError: null, lastErrorCode: null } : {}),
      ...(args.workSucceeded ? { lastWorkSucceededAt: now } : {}),
      ...(failure ? { lastFailedAt: now, lastError: safeError(args.error),
        lastErrorCode: args.errorCode, lastErrorAt: now,
        consecutiveFailures: { increment: 1 }, backoffUntil: args.backoffUntil } : {}),
      lastOutcome: args.outcome, lastSkipReason: skip ? args.outcome : null,
      totalRuns: { increment: 1 }, ...(failure ? { totalFailures: { increment: 1 } } : {}),
      ...(skip ? { totalSkips: { increment: 1 } } : {}),
      ...(args.outcome === 'lock_skipped' ? {
        totalLockSkips: { increment: 1 }, lastLockSkippedAt: now,
      } : {}),
      ...(args.summary !== undefined ? { lastSummaryJson: args.summary } : {}),
      lastDurationMs: Math.max(0, now.getTime() - (args.startedAt ?? now).getTime()),
    },
  });
  if (args.outcome === 'lock_skipped' &&
      (!previous?.lastLockSkippedAt ||
       now.getTime() - previous.lastLockSkippedAt.getTime() >= definition.staleAfterMs)) {
    const account = await prisma.tradingAccount.findUnique({
      where: { id: args.tradingAccountId },
      select: { displayName: true, environment: true },
    });
    if (account) {
      await createSystemEvent({
        type: 'account_worker_health.lock_contention',
        entityType: 'tradingAccountWorker',
        entityId: `${args.tradingAccountId}:${args.workerKey}`,
        tradingAccountId: args.tradingAccountId,
        message: `${account.displayName} ${args.workerKey} skipped because another process owns the workflow lock.`,
        payloadJson: {
          tradingAccountId: args.tradingAccountId,
          workerKey: args.workerKey,
          displayName: account.displayName,
          environment: account.environment,
          processInstanceId: args.processInstanceId,
          previousStatus,
          nextStatus: deriveTradingAccountWorkerStatus(state, definition, now),
          reason: 'lock_not_acquired',
          consecutiveFailures: state.consecutiveFailures,
          totalLockSkips: state.totalLockSkips,
          lastSucceededAt: state.lastSucceededAt,
          lastFailedAt: state.lastFailedAt,
        },
      });
    }
  }
  const nextStatus = deriveTradingAccountWorkerStatus(state, definition, now);
  await emitTransition({ state, previousStatus, nextStatus, reason: state.lastError ?? state.lastSkipReason });
  return { ...state, status: nextStatus };
}

export async function startTradingAccountWorkerRun(args: {
  tradingAccountId: number;
  workerKey: WorkerKey;
  processInstanceId: string;
  startedAt: Date;
}) {
  const definition = getWorkerDefinition(args.workerKey);
  const previous = await prisma.tradingAccountWorkerHealthState.findUnique({
    where: { tradingAccountId_workerKey: {
      tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
    } },
  });

  if (previous?.currentRunStartedAt &&
      previous.processInstanceId !== args.processInstanceId) {
    await prisma.tradingAccountWorkerHealthState.update({
      where: { id: previous.id },
      data: {
        currentRunStartedAt: null,
        lastFailedAt: args.startedAt,
        lastErrorAt: args.startedAt,
        lastErrorCode: 'INTERRUPTED_PREVIOUS_PROCESS',
        lastError: 'Previous process ended before this account workflow completed.',
        consecutiveFailures: { increment: 1 },
        totalFailures: { increment: 1 },
      },
    });
    await createSystemEvent({
      type: 'account_worker_health.interrupted',
      entityType: 'tradingAccountWorker',
      entityId: `${args.tradingAccountId}:${args.workerKey}`,
      tradingAccountId: args.tradingAccountId,
      message: `Account workflow ${args.workerKey} was interrupted in a previous process.`,
      payloadJson: {
        tradingAccountId: args.tradingAccountId,
        workerKey: args.workerKey,
        previousProcessInstanceId: previous.processInstanceId,
        nextProcessInstanceId: args.processInstanceId,
        previousRunStartedAt: previous.currentRunStartedAt,
      },
    });
  }

  return prisma.tradingAccountWorkerHealthState.upsert({
    where: { tradingAccountId_workerKey: {
      tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
    } },
    create: {
      tradingAccountId: args.tradingAccountId,
      workerKey: args.workerKey,
      processInstanceId: args.processInstanceId,
      expectedIntervalMs: definition.expectedIntervalMs,
      currentRunStartedAt: args.startedAt,
      lastTickStartedAt: args.startedAt,
    },
    update: {
      processInstanceId: args.processInstanceId,
      expectedIntervalMs: definition.expectedIntervalMs,
      currentRunStartedAt: args.startedAt,
      lastTickStartedAt: args.startedAt,
    },
  });
}

export async function listTradingAccountWorkerHealth(tradingAccountId: number) {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { id: true, displayName: true, environment: true },
  });
  if (!account) return null;
  const states = await prisma.tradingAccountWorkerHealthState.findMany({
    where: { tradingAccountId }, orderBy: { workerKey: 'asc' },
  });
  return {
    tradingAccount: account,
    generatedAt: new Date().toISOString(),
    workers: states.map((state) => ({
      ...state,
      status: deriveTradingAccountWorkerStatus(
        state, getWorkerDefinition(state.workerKey as WorkerKey)
      ),
    })),
  };
}
