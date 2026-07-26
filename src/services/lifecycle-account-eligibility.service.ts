import {
  BrokerCredentialStatus,
  TradingAccountStatus,
  type TradingAccountEnvironment,
  type TradingBroker,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { NONTERMINAL_BROKER_ORDER_PRISMA_FILTER } from './broker-order-lifecycle-status.service.js';

export type LifecycleWorkflow =
  | 'pending_submissions'
  | 'submitted_orders'
  | 'broker_activities'
  | 'positions'
  | 'scheduled_snapshots';

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
    hasLifecycleWork: boolean;
  };
};

export async function enumerateLifecycleAccounts(
  workflow: LifecycleWorkflow
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

  const intentCounts = await prisma.orderIntent.groupBy({
    by: ['tradingAccountId', 'status'],
    where: {
      tradingAccountId: { not: null },
      status: { in: ['pending', 'submitting', 'submitted'] },
    },
    _count: { _all: true },
  });

  const countsByAccount = new Map<number, Record<string, number>>();
  for (const row of intentCounts) {
    if (row.tradingAccountId === null) continue;
    const counts = countsByAccount.get(row.tradingAccountId) ?? {};
    counts[row.status] = row._count._all;
    countsByAccount.set(row.tradingAccountId, counts);
  }

  return accounts.map((account) => {
    const counts = countsByAccount.get(account.id) ?? {};
    const exposureSummary = {
      pendingIntents: counts.pending ?? 0,
      submittingIntents: counts.submitting ?? 0,
      submittedIntents: counts.submitted ?? 0,
      nonterminalOrders: account._count.brokerOrders,
      activePositions: account._count.trackedPositions,
      unresolvedActivities: account._count.brokerActivities,
      hasLifecycleWork: account._count.orderIntents > 0 ||
        account._count.brokerOrders > 0 ||
        account._count.trackedPositions > 0 ||
        account._count.brokerActivities > 0,
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
}
