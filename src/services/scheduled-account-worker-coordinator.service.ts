import type { Prisma } from '@prisma/client';
import type { WorkerKey } from '../workers/worker-health.definitions.js';
import {
  enumerateLifecycleAccounts,
  type LifecycleWorkflow,
} from './lifecycle-account-eligibility.service.js';
import {
  type AccountWorkflowClassification,
} from './trading-account-workflow-runner.service.js';
import { accountWorkflowProcessInstanceId } from './trading-account-workflow-runner.service.js';
import { recordTradingAccountWorkerAttempt } from './trading-account-worker-health.service.js';

export type ScheduledAccountDecision = 'not_due' | 'disabled';

export async function propagateScheduledAccountDecision(args: {
  workflow: LifecycleWorkflow;
  workerKey: WorkerKey;
  lockFamily: string;
  decision: ScheduledAccountDecision;
}) {
  // Disabled/not-due propagation is worker-health bookkeeping only. It must
  // not compete with actual lifecycle work for the account mutation barrier.
  const accounts = await enumerateLifecycleAccounts(args.workflow, {
    persistWorkerHealth: false,
  });
  const results = [];

  for (const account of accounts) {
    const classification = (): AccountWorkflowClassification => {
      if (args.decision === 'disabled') {
        return {
          outcome: 'dormant',
          eligibilityReason: 'worker_disabled',
          summary: {
            reason: 'worker_disabled',
            exposureSummary: account.exposureSummary,
          } as Prisma.InputJsonValue,
        };
      }
      if (account.reason === 'credentials_unavailable_with_exposure') {
        return {
          outcome: 'failure',
          error: new Error(
            'Broker credentials are unavailable while account lifecycle exposure exists.'
          ),
          errorCode: 'CREDENTIALS_UNAVAILABLE_WITH_EXPOSURE',
          eligible: false,
          eligibilityReason: account.reason,
          summary: account.exposureSummary as Prisma.InputJsonValue,
        };
      }
      if (!account.eligible) {
        return {
          outcome: 'dormant',
          eligibilityReason: account.reason,
          summary: account.exposureSummary as Prisma.InputJsonValue,
        };
      }
      return {
        outcome: 'skipped',
        skipReason: 'not_due',
        summary: { reason: 'not_due' },
      };
    };

    const decision = classification();
    const startedAt = new Date();
    if (decision.outcome === 'failure') {
      await recordTradingAccountWorkerAttempt({
        tradingAccountId: account.tradingAccountId, workerKey: args.workerKey,
        processInstanceId: accountWorkflowProcessInstanceId, outcome: 'failure',
        error: decision.error,
        ...(decision.errorCode !== undefined ? { errorCode: decision.errorCode } : {}),
        ...(decision.eligible !== undefined ? { eligible: decision.eligible } : {}),
        ...(decision.eligibilityReason !== undefined ? { eligibilityReason: decision.eligibilityReason } : {}),
        ...(decision.summary !== undefined ? { summary: decision.summary } : {}), startedAt,
      });
    } else if (decision.outcome === 'dormant') {
      await recordTradingAccountWorkerAttempt({
        tradingAccountId: account.tradingAccountId, workerKey: args.workerKey,
        processInstanceId: accountWorkflowProcessInstanceId, outcome: 'dormant',
        applicable: false, eligible: false,
        eligibilityReason: decision.eligibilityReason ?? null,
        ...(decision.summary !== undefined ? { summary: decision.summary } : {}), startedAt,
      });
    } else {
      await recordTradingAccountWorkerAttempt({
        tradingAccountId: account.tradingAccountId, workerKey: args.workerKey,
        processInstanceId: accountWorkflowProcessInstanceId, outcome: 'skipped',
        skipReason: decision.outcome === 'skipped' ? decision.skipReason : 'not_due',
        ...(decision.summary !== undefined ? { summary: decision.summary } : {}), startedAt,
      });
    }
    const run = decision.outcome === 'failure'
      ? { outcome: 'FAILED' as const, error: decision.error }
      : { outcome: 'SKIPPED' as const, value: { decision: args.decision } };

    results.push({
      account,
      outcome: run.outcome,
      ...(run.outcome === 'FAILED'
        ? { error: run.error instanceof Error ? run.error.message : 'Unknown worker error.' }
        : {}),
    });
  }

  return { accounts, results };
}
