import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import type { WorkerKey } from '../workers/worker-health.definitions.js';
import {
  recordTradingAccountWorkerAttempt,
  startTradingAccountWorkerRun,
} from './trading-account-worker-health.service.js';
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
  | { outcome: 'SKIPPED'; value: T }
  | { outcome: 'LOCK_SKIPPED' }
  | { outcome: 'BACKING_OFF'; backoffUntil: Date }
  | { outcome: 'FAILED'; error: unknown; value?: T };

export type AccountWorkflowClassification =
  | { outcome: 'success'; workSucceeded?: boolean; summary?: Prisma.InputJsonValue }
  | { outcome: 'skipped'; summary?: Prisma.InputJsonValue }
  | { outcome: 'failure'; error: unknown; errorCode?: string; summary?: Prisma.InputJsonValue };

export async function runTradingAccountWorkflow<T>(args: {
  tradingAccountId: number;
  workerKey: WorkerKey;
  lockFamily: string;
  execute: () => Promise<T>;
  classify?: (value: T) => AccountWorkflowClassification;
}): Promise<AccountWorkflowRunResult<T>> {
  const classify: (value: T) => AccountWorkflowClassification = args.classify ?? (() => ({
    outcome: 'success' as const,
    workSucceeded: true,
  }));

  // Narrow unit-test Prisma doubles can exercise the account core without
  // pretending to provide the durable health model.
  if (!prisma.tradingAccountWorkerHealthState) {
    try {
      const value = await args.execute();
      const classification = classify(value);
      if (classification.outcome === 'failure') {
        return { outcome: 'FAILED', error: classification.error, value };
      }
      return {
        outcome: classification.outcome === 'skipped' ? 'SKIPPED' : 'PROCESSED',
        value,
      };
    } catch (error) {
      return { outcome: 'FAILED', error };
    }
  }
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
        await recordTradingAccountWorkerAttempt({
          tradingAccountId: args.tradingAccountId,
          workerKey: args.workerKey,
          processInstanceId: accountWorkflowProcessInstanceId,
          outcome: 'backoff_skipped',
          startedAt: new Date(),
          backoffUntil: persisted.backoffUntil,
        });
        return { backingOff: persisted.backoffUntil } as const;
      }

      const startedAt = new Date();
      const startedState = await startTradingAccountWorkerRun({
        tradingAccountId: args.tradingAccountId,
        workerKey: args.workerKey,
        processInstanceId: accountWorkflowProcessInstanceId,
        startedAt,
      });
      try {
        const value = await args.execute();
        const classification = classify(value);
        if (classification.outcome === 'failure') {
          const failures = startedState.consecutiveFailures + 1;
          const delayMs = Math.min(
            1_000 * 2 ** Math.min(failures - 1, 10),
            BACKOFF_CAP_MS[args.workerKey]
          );
          await recordTradingAccountWorkerAttempt({
            tradingAccountId: args.tradingAccountId,
            workerKey: args.workerKey,
            processInstanceId: accountWorkflowProcessInstanceId,
            outcome: 'failure',
            error: classification.error,
            errorCode: classification.errorCode ?? 'CLASSIFIED_FAILURE',
            ...(classification.summary !== undefined
              ? { summary: classification.summary }
              : {}),
            backoffUntil: new Date(Date.now() + delayMs),
            startedAt,
          });
          return { failed: classification.error, value } as const;
        }
        await recordTradingAccountWorkerAttempt({
          tradingAccountId: args.tradingAccountId,
          workerKey: args.workerKey,
          processInstanceId: accountWorkflowProcessInstanceId,
          outcome: 'success',
          workSucceeded: classification.outcome === 'success'
            ? classification.workSucceeded ?? true
            : false,
          ...(classification.summary !== undefined
            ? { summary: classification.summary }
            : {}),
          startedAt,
        });
        return { value, skipped: classification.outcome === 'skipped' } as const;
      } catch (error) {
        const failures = startedState.consecutiveFailures + 1;
        const delayMs = Math.min(
          1_000 * 2 ** Math.min(failures - 1, 10),
          BACKOFF_CAP_MS[args.workerKey]
        );
        await recordTradingAccountWorkerAttempt({
          tradingAccountId: args.tradingAccountId,
          workerKey: args.workerKey,
          processInstanceId: accountWorkflowProcessInstanceId,
          outcome: 'failure',
          error,
          errorCode: 'WORKFLOW_ERROR',
          backoffUntil: new Date(Date.now() + delayMs),
          startedAt,
        });
        return { failed: error } as const;
      }
    },
  });

  if (locked.outcome === 'NOT_ACQUIRED') {
    const startedAt = new Date();
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
      return { outcome: 'BACKING_OFF', backoffUntil: locked.value.backingOff };
    }
    if ('failed' in locked.value) {
      return {
        outcome: 'FAILED',
        error: locked.value.failed,
        ...(locked.value.value !== undefined ? { value: locked.value.value } : {}),
      };
    }
    return {
      outcome: locked.value.skipped ? 'SKIPPED' : 'PROCESSED',
      value: locked.value.value,
    };
  }

  return { outcome: 'FAILED', error: locked.error };
}
