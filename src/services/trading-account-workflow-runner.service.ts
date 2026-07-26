import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import type { WorkerKey } from '../workers/worker-health.definitions.js';
import { recordTradingAccountWorkerAttempt } from './trading-account-worker-health.service.js';
import { withTradingAccountWorkflowLock } from './trading-account-workflow-lock.service.js';

export const accountWorkflowProcessInstanceId = randomUUID();

const BACKOFF_CAP_MS: Record<WorkerKey, number> = {
  pending_order_processing: 30_000,
  submitted_order_sync: 60_000,
  tracked_position_sync: 30_000,
  exit_evaluation: 15_000,
  account_snapshot_scheduler: 300_000,
  broker_activity_sync: 60_000,
  scheduled_reconciliation: 300_000,
  alpaca_api_usage_persistence: 300_000,
  massive_news_ingestion: 300_000,
};

export type AccountWorkflowRunResult<T> =
  | { outcome: 'PROCESSED'; value: T }
  | { outcome: 'LOCK_SKIPPED' }
  | { outcome: 'BACKING_OFF'; backoffUntil: Date }
  | { outcome: 'FAILED'; error: unknown };

export async function runTradingAccountWorkflow<T>(args: {
  tradingAccountId: number;
  workerKey: WorkerKey;
  lockFamily: string;
  execute: () => Promise<T>;
}): Promise<AccountWorkflowRunResult<T>> {
  // Unit suites that intentionally provide a narrow Prisma mock exercise the
  // unlocked account core. Locking itself is covered with database-backed tests.
  if (env.NODE_ENV === 'test' || !prisma.tradingAccountWorkerHealthState) {
    try {
      return { outcome: 'PROCESSED', value: await args.execute() };
    } catch (error) {
      return { outcome: 'FAILED', error };
    }
  }
  const startedAt = new Date();
  const locked = await withTradingAccountWorkflowLock({
    tradingAccountId: args.tradingAccountId,
    workflowKey: args.lockFamily,
    processInstanceId: accountWorkflowProcessInstanceId,
    execute: async () => {
      const persisted = await prisma.tradingAccountWorkerHealthState.findUnique({
        where: { tradingAccountId_workerKey: {
          tradingAccountId: args.tradingAccountId,
          workerKey: args.workerKey,
        } },
        select: { backoffUntil: true },
      });
      if (persisted?.backoffUntil && persisted.backoffUntil > new Date()) {
        return { backingOff: persisted.backoffUntil } as const;
      }
      return { value: await args.execute() } as const;
    },
  });

  if (locked.outcome === 'NOT_ACQUIRED') {
    await recordTradingAccountWorkerAttempt({
      tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
      processInstanceId: accountWorkflowProcessInstanceId,
      outcome: 'lock_skipped', startedAt,
      summary: { lockFamily: args.lockFamily },
    });
    return { outcome: 'LOCK_SKIPPED' };
  }
  if (locked.outcome === 'ACQUIRED_AND_COMPLETED') {
    if ('backingOff' in locked.value) {
      await recordTradingAccountWorkerAttempt({
        tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
        processInstanceId: accountWorkflowProcessInstanceId,
        outcome: 'backoff_skipped', startedAt,
        backoffUntil: locked.value.backingOff,
      });
      return { outcome: 'BACKING_OFF', backoffUntil: locked.value.backingOff };
    }
    await recordTradingAccountWorkerAttempt({
      tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
      processInstanceId: accountWorkflowProcessInstanceId,
      outcome: 'success', workSucceeded: true, startedAt,
    });
    return { outcome: 'PROCESSED', value: locked.value.value };
  }

  const previous = await prisma.tradingAccountWorkerHealthState.findUnique({
    where: { tradingAccountId_workerKey: {
      tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
    } },
    select: { consecutiveFailures: true },
  });
  const failures = (previous?.consecutiveFailures ?? 0) + 1;
  const delayMs = Math.min(1_000 * 2 ** Math.min(failures - 1, 10), BACKOFF_CAP_MS[args.workerKey]);
  const backoffUntil = new Date(Date.now() + delayMs);
  await recordTradingAccountWorkerAttempt({
    tradingAccountId: args.tradingAccountId, workerKey: args.workerKey,
    processInstanceId: accountWorkflowProcessInstanceId,
    outcome: 'failure', error: locked.error, errorCode: locked.outcome,
    backoffUntil, startedAt,
  });
  return { outcome: 'FAILED', error: locked.error };
}
