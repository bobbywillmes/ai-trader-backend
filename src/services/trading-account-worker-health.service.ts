import type { Prisma, TradingAccountWorkerHealthState } from '@prisma/client';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { createSystemEvent } from './system-event.service.js';
import { getWorkerDefinition, type WorkerKey } from '../workers/worker-health.definitions.js';

export type AccountWorkerStatus =
  | 'HEALTHY' | 'DORMANT' | 'STARTING' | 'DEGRADED'
  | 'DELAYED' | 'STALE' | 'FAILING' | 'BACKING_OFF';

const MAX_ERROR_LENGTH = 500;
const TRANSITION_EVENT_STATUSES = new Set<AccountWorkerStatus>(['FAILING', 'STALE']);
const RECOVERABLE_STATUSES = new Set<AccountWorkerStatus>([
  'FAILING', 'STALE', 'DEGRADED', 'BACKING_OFF',
]);
type HealthLogger = Pick<typeof logger, 'trace' | 'info' | 'warn' | 'error'>;

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
}

function failureFingerprint(state: Pick<TradingAccountWorkerHealthState,
  'tradingAccountId' | 'workerKey' | 'lastErrorCode' | 'lastSummaryJson'>) {
  const safeEntityIds: string[] = [];
  const visit = (value: unknown, key = '') => {
    if (safeEntityIds.length >= 10 || value === null || value === undefined) return;
    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, key));
      } else {
        Object.entries(value as Record<string, unknown>)
          .forEach(([childKey, child]) => visit(child, childKey));
      }
      return;
    }
    if (/id$/i.test(key) && ['string', 'number'].includes(typeof value)) {
      safeEntityIds.push(`${key}:${String(value)}`);
    }
  };
  visit(state.lastSummaryJson);
  return [
    state.tradingAccountId,
    state.workerKey,
    state.lastErrorCode ?? 'UNKNOWN',
    ...safeEntityIds.sort(),
  ].join('|');
}

async function logHealthTransition(
  previous: TradingAccountWorkerHealthState | null,
  state: TradingAccountWorkerHealthState,
  previousStatus: AccountWorkerStatus,
  nextStatus: AccountWorkerStatus,
  db: typeof prisma,
  healthLogger: HealthLogger
) {
  const account = await db.tradingAccount.findUnique({
    where: { id: state.tradingAccountId },
    select: { displayName: true, environment: true },
  });
  if (!account) return;

  const context = {
    tradingAccountId: state.tradingAccountId,
    displayName: account.displayName,
    environment: account.environment,
    workerKey: state.workerKey,
  };
  if (state.consecutiveFailures > 0) {
    const fingerprint = failureFingerprint(state);
    const previousFingerprint = previous?.consecutiveFailures
      ? failureFingerprint(previous)
      : null;
    if (fingerprint !== previousFingerprint) {
      healthLogger.error({
        ...context,
        errorCode: state.lastErrorCode,
        error: state.lastError,
        failureFingerprint: fingerprint,
      }, 'Account workflow entered a failing state.');
    }
    return;
  }

  if (previous && isAccountWorkerRecoveryTransition(previousStatus, nextStatus)) {
    const failureDurationMs = previous.lastFailedAt
      ? Math.max(0, state.lastTickCompletedAt!.getTime() - previous.lastFailedAt.getTime())
      : null;
    healthLogger.info({
      ...context,
      previousStatus,
      recoveredStatus: nextStatus,
      failureDurationMs,
    }, 'Account workflow recovered.');
    return;
  }

  if (previousStatus !== nextStatus && ['DELAYED', 'STALE'].includes(nextStatus)) {
    healthLogger.warn({
      ...context,
      previousStatus,
      nextStatus,
      totalLockSkips: state.totalLockSkips,
    }, 'Account workflow lock contention affected health.');
    return;
  }

  healthLogger.trace({ ...context, outcome: state.lastOutcome, status: nextStatus },
    'Account workflow completed.');
}

export function isAccountWorkerRecoveryTransition(
  previousStatus: AccountWorkerStatus,
  nextStatus: AccountWorkerStatus
) {
  return nextStatus === 'HEALTHY' && RECOVERABLE_STATUSES.has(previousStatus);
}

export function deriveTradingAccountWorkerStatus(
  state: Pick<TradingAccountWorkerHealthState,
    'applicable' | 'eligible' | 'currentRunStartedAt' | 'lastSucceededAt' |
    'lastFailedAt' | 'consecutiveFailures' | 'backoffUntil' | 'lastLockSkippedAt' |
    'totalLockSkips' | 'createdAt'>,
  definition: ReturnType<typeof getWorkerDefinition>,
  now = new Date()
): AccountWorkerStatus {
  if (!state.applicable) return 'DORMANT';
  if (state.backoffUntil && state.backoffUntil > now) return 'BACKING_OFF';
  if (state.consecutiveFailures > 0) return 'FAILING';
  if (state.currentRunStartedAt &&
      now.getTime() - state.currentRunStartedAt.getTime() > definition.maxRunDurationMs) return 'DEGRADED';
  if (!state.lastSucceededAt) {
    if (state.totalLockSkips > 0) {
      const contentionAge = now.getTime() - state.createdAt.getTime();
      if (contentionAge > definition.staleAfterMs) return 'STALE';
      if (contentionAge > definition.delayedAfterMs) return 'DELAYED';
    }
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
}, dependencies: {
  db?: typeof prisma;
  emitSystemEvent?: typeof createSystemEvent;
  logger?: HealthLogger;
} = {}) {
  const db = dependencies.db ?? prisma;
  const emitSystemEvent = dependencies.emitSystemEvent ?? createSystemEvent;
  if (args.previousStatus === args.nextStatus) return;
  const account = await db.tradingAccount.findUnique({
    where: { id: args.state.tradingAccountId },
    select: { displayName: true, environment: true },
  });
  if (!account) return;
  const recovered = isAccountWorkerRecoveryTransition(
    args.previousStatus,
    args.nextStatus
  );
  if (!recovered && !TRANSITION_EVENT_STATUSES.has(args.nextStatus)) return;
  await emitSystemEvent({
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
  outcome: 'success' | 'skipped' | 'failure' | 'dormant' | 'backoff_skipped';
  skipReason?: string | null;
  applicable?: boolean;
  eligible?: boolean;
  eligibilityReason?: string | null;
  workSucceeded?: boolean;
  error?: unknown;
  errorCode?: string | null;
  summary?: Prisma.InputJsonValue;
  backoffUntil?: Date | null;
  startedAt?: Date;
}, dependencies: {
  db?: typeof prisma;
  emitSystemEvent?: typeof createSystemEvent;
  logger?: HealthLogger;
} = {}) {
  const db = dependencies.db ?? prisma;
  const definition = getWorkerDefinition(args.workerKey);
  const now = new Date();
  const previous = await db.tradingAccountWorkerHealthState.findUnique({
    where: { tradingAccountId_workerKey: {
      tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
    } },
  });
  const previousStatus = previous
    ? deriveTradingAccountWorkerStatus(previous, definition, now) : 'STARTING';
  const failure = args.outcome === 'failure';
  const success = args.outcome === 'success' || args.outcome === 'skipped' ||
    args.outcome === 'dormant';
  const skip = args.outcome.endsWith('skipped') || args.outcome === 'dormant';
  const state = await db.tradingAccountWorkerHealthState.upsert({
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
      lastSkipReason: skip ? (args.skipReason ?? args.outcome) : null, totalRuns: 1,
      totalFailures: failure ? 1 : 0, totalSkips: skip ? 1 : 0,
      totalLockSkips: 0,
      lastLockSkippedAt: null,
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
      lastOutcome: args.outcome,
      lastSkipReason: skip ? (args.skipReason ?? args.outcome) : null,
      totalRuns: { increment: 1 }, ...(failure ? { totalFailures: { increment: 1 } } : {}),
      ...(skip ? { totalSkips: { increment: 1 } } : {}),
      ...(args.summary !== undefined ? { lastSummaryJson: args.summary } : {}),
      lastDurationMs: Math.max(0, now.getTime() - (args.startedAt ?? now).getTime()),
    },
  });
  const nextStatus = deriveTradingAccountWorkerStatus(state, definition, now);
  await logHealthTransition(
    previous,
    state,
    previousStatus,
    nextStatus,
    db,
    dependencies.logger ?? logger
  );
  await emitTransition(
    { state, previousStatus, nextStatus, reason: state.lastError ?? state.lastSkipReason },
    dependencies
  );
  return { ...state, status: nextStatus };
}

const CONTENTION_WITHOUT_OWNER_PROCESS_ID = 'lock-contention:no-owner';

export async function recordTradingAccountWorkflowLockContention(args: {
  tradingAccountId: number;
  workerKey: WorkerKey;
  contenderProcessInstanceId: string;
  lockFamily: string;
  attemptedAt: Date;
}, dependencies: {
  db?: typeof prisma;
  emitSystemEvent?: typeof createSystemEvent;
  logger?: HealthLogger;
} = {}) {
  const db = dependencies.db ?? prisma;
  const emitSystemEvent = dependencies.emitSystemEvent ?? createSystemEvent;
  const definition = getWorkerDefinition(args.workerKey);
  const previous = await db.tradingAccountWorkerHealthState.findUnique({
    where: { tradingAccountId_workerKey: {
      tradingAccountId: args.tradingAccountId,
      workerKey: args.workerKey,
    } },
  });
  const previousStatus = previous
    ? deriveTradingAccountWorkerStatus(
        previous,
        definition,
        previous.lastLockSkippedAt ?? args.attemptedAt
      )
    : 'STARTING';
  const summary = {
    reason: 'lock_not_acquired',
    lockFamily: args.lockFamily,
    contenderProcessInstanceId: args.contenderProcessInstanceId,
    attemptedAt: args.attemptedAt.toISOString(),
  };
  const state = await db.tradingAccountWorkerHealthState.upsert({
    where: { tradingAccountId_workerKey: {
      tradingAccountId: args.tradingAccountId,
      workerKey: args.workerKey,
    } },
    create: {
      tradingAccountId: args.tradingAccountId,
      workerKey: args.workerKey,
      processInstanceId: CONTENTION_WITHOUT_OWNER_PROCESS_ID,
      expectedIntervalMs: definition.expectedIntervalMs,
      currentRunStartedAt: null,
      lastOutcome: 'lock_skipped',
      lastSkipReason: 'lock_skipped',
      totalRuns: 1,
      totalSkips: 1,
      totalLockSkips: 1,
      lastLockSkippedAt: args.attemptedAt,
      lastSummaryJson: summary,
    },
    update: {
      lastSkipReason: 'lock_skipped',
      totalRuns: { increment: 1 },
      totalSkips: { increment: 1 },
      totalLockSkips: { increment: 1 },
      lastLockSkippedAt: args.attemptedAt,
      lastSummaryJson: summary,
    },
  });

  if (!previous?.lastLockSkippedAt ||
      args.attemptedAt.getTime() - previous.lastLockSkippedAt.getTime() >=
        definition.staleAfterMs) {
    const account = await db.tradingAccount.findUnique({
      where: { id: args.tradingAccountId },
      select: { displayName: true, environment: true },
    });
    if (account) {
      await emitSystemEvent({
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
          ownerProcessInstanceId: state.currentRunStartedAt
            ? state.processInstanceId
            : null,
          contenderProcessInstanceId: args.contenderProcessInstanceId,
          lockFamily: args.lockFamily,
          previousStatus,
          nextStatus: deriveTradingAccountWorkerStatus(
            state, definition, args.attemptedAt
          ),
          reason: 'lock_not_acquired',
          consecutiveFailures: state.consecutiveFailures,
          totalLockSkips: state.totalLockSkips,
          lastSucceededAt: state.lastSucceededAt,
          lastFailedAt: state.lastFailedAt,
        },
      });
    }
  }
  const nextStatus = deriveTradingAccountWorkerStatus(
    state, definition, args.attemptedAt
  );
  await logHealthTransition(
    previous,
    state,
    previousStatus,
    nextStatus,
    db,
    dependencies.logger ?? logger
  );
  await emitTransition(
    { state, previousStatus, nextStatus, reason: 'lock_skipped' },
    { db, emitSystemEvent }
  );
  return { ...state, status: nextStatus };
}

export async function startTradingAccountWorkerRun(args: {
  tradingAccountId: number;
  workerKey: WorkerKey;
  processInstanceId: string;
  startedAt: Date;
}, dependencies: {
  db?: typeof prisma;
  emitSystemEvent?: typeof createSystemEvent;
} = {}) {
  const db = dependencies.db ?? prisma;
  const emitSystemEvent = dependencies.emitSystemEvent ?? createSystemEvent;
  const definition = getWorkerDefinition(args.workerKey);
  const previous = await db.tradingAccountWorkerHealthState.findUnique({
    where: { tradingAccountId_workerKey: {
      tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
    } },
  });

  if (previous?.currentRunStartedAt &&
      previous.processInstanceId !== args.processInstanceId) {
    await db.tradingAccountWorkerHealthState.update({
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
    await emitSystemEvent({
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

  return db.tradingAccountWorkerHealthState.upsert({
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
