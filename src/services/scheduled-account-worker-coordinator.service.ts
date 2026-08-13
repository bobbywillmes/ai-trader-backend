import type { Prisma } from '@prisma/client';
import type { WorkerKey } from '../workers/worker-health.definitions.js';
import {
  enumerateLifecycleAccounts,
  type LifecycleWorkflow,
} from './lifecycle-account-eligibility.service.js';
import {
  runTradingAccountWorkflow,
  type AccountWorkflowClassification,
} from './trading-account-workflow-runner.service.js';

export type ScheduledAccountDecision = 'not_due' | 'disabled';

export async function propagateScheduledAccountDecision(args: {
  workflow: LifecycleWorkflow;
  workerKey: WorkerKey;
  lockFamily: string;
  decision: ScheduledAccountDecision;
}) {
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

    const run = await runTradingAccountWorkflow({
      tradingAccountId: account.tradingAccountId,
      workerKey: args.workerKey,
      lockFamily: args.lockFamily,
      execute: async () => ({ decision: args.decision }),
      classify: classification,
      ignoreBackoffWhenInapplicable: args.decision === 'disabled',
    });

    results.push({
      account,
      outcome: run.outcome,
      ...(run.outcome === 'BACKING_OFF'
        ? { backoffUntil: run.backoffUntil.toISOString() }
        : {}),
      ...(run.outcome === 'FAILED'
        ? { error: run.error instanceof Error ? run.error.message : 'Unknown worker error.' }
        : {}),
    });
  }

  return { accounts, results };
}
