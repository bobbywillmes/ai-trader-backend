import {
  BrokerCredentialStatus,
  TradingAccountStatus,
  type TradingAccountEnvironment,
  type TradingBroker,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { NONTERMINAL_BROKER_ORDER_PRISMA_FILTER } from './broker-order-lifecycle-status.service.js';
import { env } from '../config/env.js';
import { accountWorkflowProcessInstanceId } from './trading-account-workflow-runner.service.js';
import { recordTradingAccountWorkerAttempt } from './trading-account-worker-health.service.js';
import type { WorkerKey } from '../workers/worker-health.definitions.js';

export type LifecycleWorkflow =
  | 'pending_submissions'
  | 'submitted_orders'
  | 'broker_activities'
  | 'positions'
  | 'scheduled_snapshots'
  | 'exit_evaluation'
  | 'protective_order_sync'
  | 'reconciliation'
  | 'manual_emergency_close';

export type LifecycleAccountEligibility = {
  tradingAccountId: number;
  displayName: string;
  broker: TradingBroker;
  environment: TradingAccountEnvironment;
  status: TradingAccountStatus;
  credentialStatus: BrokerCredentialStatus | null;
  eligible: boolean;
  reason:
    | 'usable_credentials_with_work'
    | 'usable_credentials_operational_account'
    | 'credentials_unavailable_with_exposure'
    | 'credentials_unavailable_dormant'
    | 'no_work_for_workflow';
  exposureSummary: {
    pendingIntents: number;
    submittingIntents: number;
    submittedIntents: number;
    nonterminalOrders: number;
    activePositions: number;
    unresolvedActivities: number;
    unresolvedExitPositions: number;
    hasLifecycleWork: boolean;
  };
};

export async function enumerateLifecycleAccounts(
  workflow: LifecycleWorkflow,
  options: { persistWorkerHealth?: boolean } = {}
): Promise<LifecycleAccountEligibility[]> {
  const accounts = await prisma.tradingAccount.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      displayName: true,
      broker: true,
      environment: true,
      status: true,
      credential: {
        select: { status: true },
      },
      _count: {
        select: {
          orderIntents: {
            where: { status: { in: ['pending', 'submitting', 'submitted'] } },
          },
          brokerOrders: {
            where: {
              status: NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
            },
          },
          trackedPositions: {
            where: { status: { in: ['open', 'closing'] } },
          },
          brokerActivities: {
            where: {
              OR: [
                { trackedPositionId: null },
                { brokerOrderRecordId: null },
              ],
            },
          },
        },
      },
    },
  });

  const [intentCounts, unresolvedExitCounts] = await Promise.all([
    prisma.orderIntent.groupBy({
      by: ['tradingAccountId', 'status'],
      where: {
        tradingAccountId: { not: null },
        status: { in: ['pending', 'submitting', 'submitted'] },
      },
      _count: { _all: true },
    }),
    prisma.trackedPosition.groupBy({
      by: ['tradingAccountId'],
      where: {
        tradingAccountId: { not: null },
        exitState: {
          is: {
            OR: [
              { attentionRequired: true },
              {
                status: {
                  in: [
                    'target_unlocked',
                    'trailing_stop_submitted',
                    'submit_failed',
                  ],
                },
              },
            ],
          },
        },
      },
      _count: { _all: true },
    }),
  ]);

  const countsByAccount = new Map<number, Record<string, number>>();
  for (const row of intentCounts) {
    if (row.tradingAccountId === null) continue;
    const counts = countsByAccount.get(row.tradingAccountId) ?? {};
    counts[row.status] = row._count._all;
    countsByAccount.set(row.tradingAccountId, counts);
  }
  const unresolvedExitCountByAccount = new Map(
    unresolvedExitCounts.flatMap((row) =>
      row.tradingAccountId === null
        ? []
        : [[row.tradingAccountId, row._count._all] as const]
    )
  );

  const results = accounts.map((account) => {
    const counts = countsByAccount.get(account.id) ?? {};
    const exposureSummary = {
      pendingIntents: counts.pending ?? 0,
      submittingIntents: counts.submitting ?? 0,
      submittedIntents: counts.submitted ?? 0,
      nonterminalOrders: account._count.brokerOrders,
      activePositions: account._count.trackedPositions,
      unresolvedActivities: account._count.brokerActivities,
      unresolvedExitPositions:
        unresolvedExitCountByAccount.get(account.id) ?? 0,
      hasLifecycleWork: account._count.orderIntents > 0 ||
        account._count.brokerOrders > 0 ||
        account._count.trackedPositions > 0 ||
        account._count.brokerActivities > 0 ||
        (unresolvedExitCountByAccount.get(account.id) ?? 0) > 0,
    };
    const usableCredentials =
      account.credential?.status === BrokerCredentialStatus.ACTIVE;
    const operational =
      account.status === TradingAccountStatus.ACTIVE ||
      account.status === TradingAccountStatus.PAUSED;
    const workflowHasWork =
      workflow === 'pending_submissions'
        ? exposureSummary.pendingIntents > 0
        : workflow === 'submitted_orders'
        ? exposureSummary.submittingIntents > 0 ||
          exposureSummary.submittedIntents > 0 ||
          exposureSummary.nonterminalOrders > 0
        : workflow === 'positions'
          ? exposureSummary.activePositions > 0 ||
            exposureSummary.nonterminalOrders > 0 ||
            operational
          : workflow === 'exit_evaluation'
            ? exposureSummary.activePositions > 0
            : workflow === 'protective_order_sync'
              ? exposureSummary.unresolvedExitPositions > 0 ||
                exposureSummary.nonterminalOrders > 0
              : workflow === 'manual_emergency_close'
                ? exposureSummary.activePositions > 0
                : workflow === 'reconciliation'
                  ? exposureSummary.hasLifecycleWork || operational
          : workflow === 'broker_activities'
            ? exposureSummary.hasLifecycleWork || operational
            : exposureSummary.hasLifecycleWork || operational;

    let eligible = false;
    let reason: LifecycleAccountEligibility['reason'];
    if (!usableCredentials) {
      reason = exposureSummary.hasLifecycleWork
        ? 'credentials_unavailable_with_exposure'
        : 'credentials_unavailable_dormant';
    } else if (!workflowHasWork) {
      reason = 'no_work_for_workflow';
    } else {
      eligible = true;
      reason = exposureSummary.hasLifecycleWork
        ? 'usable_credentials_with_work'
        : 'usable_credentials_operational_account';
    }

    return {
      tradingAccountId: account.id,
      displayName: account.displayName,
      broker: account.broker,
      environment: account.environment,
      status: account.status,
      credentialStatus: account.credential?.status ?? null,
      eligible,
      reason,
      exposureSummary,
    };
  });

  if (env.NODE_ENV !== 'test' && options.persistWorkerHealth !== false) {
    const workerKeyByWorkflow: Partial<Record<LifecycleWorkflow, WorkerKey>> = {
      pending_submissions: 'pending_order_processing',
      submitted_orders: 'submitted_order_sync',
      broker_activities: 'broker_activity_sync',
      positions: 'tracked_position_sync',
      scheduled_snapshots: 'account_snapshot_scheduler',
      exit_evaluation: 'exit_evaluation',
      protective_order_sync: 'exit_evaluation',
      reconciliation: 'scheduled_reconciliation',
    };
    const workerKey = workerKeyByWorkflow[workflow];
    if (workerKey) {
      await Promise.all(results.filter((account) => !account.eligible).map((account) =>
        recordTradingAccountWorkerAttempt({
          tradingAccountId: account.tradingAccountId,
          workerKey,
          processInstanceId: accountWorkflowProcessInstanceId,
          outcome: account.reason === 'credentials_unavailable_with_exposure'
            ? 'failure' : 'dormant',
          applicable: account.reason === 'credentials_unavailable_with_exposure',
          eligible: false,
          eligibilityReason: account.reason,
          error: account.reason === 'credentials_unavailable_with_exposure'
            ? new Error('Broker credentials are unavailable while account lifecycle exposure exists.')
            : undefined,
          errorCode: account.reason === 'credentials_unavailable_with_exposure'
            ? 'CREDENTIALS_UNAVAILABLE_WITH_EXPOSURE' : null,
          summary: account.exposureSummary,
        })
      ));
    }
  }

  return results;
}
