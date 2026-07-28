import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getTradingAccountEntryRiskUsage } from './trading-account-entry-risk-usage.service.js';
import { representsPendingEntryExposure } from './trading-account-entry-risk-limits.service.js';
import { normalizeBrokerOrderStatus } from './broker-order-lifecycle-status.service.js';
import { diagnoseHistoricalOrderLifecycle } from './historical-order-lifecycle-diagnostic.service.js';
import { withTradingAccountWorkflowLock } from './trading-account-workflow-lock.service.js';

export const HISTORICAL_ORDER_REPAIR_CONFIRMATION =
  'REPAIR HISTORICAL ORDER LIFECYCLE';
export const HISTORICAL_ORDER_REPAIR_LINK_SOURCE =
  'historical_order_lifecycle_repair';

type DiagnosticRow = Awaited<
  ReturnType<typeof diagnoseHistoricalOrderLifecycle>
>['candidates'][number];

export type HistoricalOrderRepairProposal =
  | {
      kind: 'filled_entry';
      orderIntentId: number;
      brokerOrderRecordId: number;
      trackedPositionId: number;
      brokerOrderStatus: 'filled';
      orderIntentStatus: 'filled';
      evidence: string[];
    }
  | {
      kind: 'filled_non_entry';
      orderIntentId: number;
      brokerOrderRecordId: number;
      trackedPositionId: number | null;
      brokerOrderStatus: 'filled';
      orderIntentStatus: 'filled';
      evidence: string[];
    }
  | {
      kind: 'terminal_nonfilled';
      orderIntentId: number;
      brokerOrderRecordId: number;
      trackedPositionId: null;
      brokerOrderStatus: string;
      orderIntentStatus: string;
      evidence: string[];
    };

export function buildHistoricalOrderRepairProposal(
  row: DiagnosticRow
): HistoricalOrderRepairProposal | null {
  if (
    row.classifications.includes('FULL_FILL_LOCAL_EVIDENCE') &&
    row.classifications.includes('POSITION_LINK_EXACT') &&
    row.matchedTrackedPositionId !== null &&
    row.side.toLowerCase() === 'buy'
  ) {
    return {
      kind: 'filled_entry',
      orderIntentId: row.orderIntentId,
      brokerOrderRecordId: row.brokerOrderRecordId,
      trackedPositionId: row.matchedTrackedPositionId,
      brokerOrderStatus: 'filled',
      orderIntentStatus: 'filled',
      evidence: ['FULL_FILL_LOCAL_EVIDENCE', 'POSITION_LINK_EXACT'],
    };
  }

  if (
    row.classifications.includes('FULL_FILL_LOCAL_EVIDENCE') &&
    row.side.toLowerCase() !== 'buy'
  ) {
    const supportedPositionIds = new Set(
      [
        row.orderIntentTrackedPositionId,
        row.brokerOrderTrackedPositionId,
        ...row.activityTrackedPositionIds,
      ].filter((id): id is number => id !== null)
    );
    return {
      kind: 'filled_non_entry',
      orderIntentId: row.orderIntentId,
      brokerOrderRecordId: row.brokerOrderRecordId,
      trackedPositionId:
        supportedPositionIds.size === 1
          ? [...supportedPositionIds][0]!
          : null,
      brokerOrderStatus: 'filled',
      orderIntentStatus: 'filled',
      evidence: ['FULL_FILL_LOCAL_EVIDENCE'],
    };
  }

  const brokerStatus =
    row.brokerLookup &&
    'status' in row.brokerLookup &&
    typeof row.brokerLookup.status === 'string'
      ? normalizeBrokerOrderStatus(row.brokerLookup.status)
      : null;
  if (
    row.classifications.includes('TERMINAL_BROKER_CONFIRMED') &&
    brokerStatus &&
    brokerStatus !== 'filled'
  ) {
    return {
      kind: 'terminal_nonfilled',
      orderIntentId: row.orderIntentId,
      brokerOrderRecordId: row.brokerOrderRecordId,
      trackedPositionId: null,
      brokerOrderStatus: brokerStatus,
      orderIntentStatus: brokerStatus,
      evidence: ['TERMINAL_BROKER_CONFIRMED'],
    };
  }
  return null;
}

async function slotUsage(tradingAccountId: number) {
  const [usage, riskSettings] = await Promise.all([
    getTradingAccountEntryRiskUsage({
      tradingAccountId,
      symbol: '__HISTORICAL_REPAIR__',
    }),
    prisma.tradingAccountRiskSettings.findUnique({
      where: { tradingAccountId },
      select: { maxOpenPositions: true },
    }),
  ]);
  return {
    accountMaxPositions: riskSettings?.maxOpenPositions ?? null,
    activePositionCount: usage.activePositionCount,
    pendingEntryIntentSlotCount: usage.pendingEntryPositionCount,
    usedSlots: usage.currentAccountPositionSlots,
  };
}

async function buildReport(tradingAccountId: number) {
  const [diagnostic, before] = await Promise.all([
    diagnoseHistoricalOrderLifecycle({ tradingAccountId }),
    slotUsage(tradingAccountId),
  ]);
  const proposals = diagnostic.candidates
    .map((row) => ({ row, proposal: buildHistoricalOrderRepairProposal(row) }))
    .filter(
      (
        item
      ): item is {
        row: DiagnosticRow;
        proposal: HistoricalOrderRepairProposal;
      } => item.proposal !== null
    );
  const proposedIntentIds = new Set(
    proposals.map((item) => item.proposal.orderIntentId)
  );
  const repairedPendingCount = countPendingRepairIntents(
    diagnostic.candidates,
    proposedIntentIds
  );
  const refused = diagnostic.candidates
    .filter((row) => !proposedIntentIds.has(row.orderIntentId))
    .map((row) => ({
      orderIntentId: row.orderIntentId,
      brokerOrderRecordId: row.brokerOrderRecordId,
      classifications: row.classifications,
      reason: 'no_deterministic_mutation',
    }));

  return {
    diagnostic,
    proposals,
    refused,
    slotUsage: {
      before,
      expectedAfter: {
        ...before,
        pendingEntryIntentSlotCount: Math.max(
          0,
          before.pendingEntryIntentSlotCount - repairedPendingCount
        ),
        usedSlots: Math.max(0, before.usedSlots - repairedPendingCount),
      },
    },
    safeToApply: proposals.length > 0,
  };
}

export function countPendingRepairIntents(
  rows: DiagnosticRow[],
  proposedIntentIds: Set<number>
) {
  return rows.filter(
    (row) =>
      proposedIntentIds.has(row.orderIntentId) &&
      representsPendingEntryExposure({
        side: row.side,
        status: row.orderIntentStatus,
        blockReason: row.blockReason,
        trackedPositionId: row.orderIntentTrackedPositionId,
      })
  ).length;
}

async function applyProposals(args: {
  tradingAccountId: number;
  runId: string;
  proposals: Array<{
    row: DiagnosticRow;
    proposal: HistoricalOrderRepairProposal;
  }>;
}) {
  return prisma.$transaction(async (tx) => {
    const repaired = [];
    for (const { row, proposal } of args.proposals) {
      const currentOrder = await tx.brokerOrder.findFirst({
        where: {
          id: proposal.brokerOrderRecordId,
          tradingAccountId: args.tradingAccountId,
        },
        include: { orderIntent: true },
      });
      if (!currentOrder || currentOrder.orderIntentId !== proposal.orderIntentId) {
        throw new Error(
          `Lifecycle group ${proposal.brokerOrderRecordId} changed after diagnosis.`
        );
      }
      if (
        currentOrder.status === proposal.brokerOrderStatus &&
        currentOrder.orderIntent.status === proposal.orderIntentStatus &&
        currentOrder.trackedPositionId === proposal.trackedPositionId &&
        currentOrder.orderIntent.trackedPositionId === proposal.trackedPositionId
      ) {
        continue;
      }

      if (proposal.kind === 'filled_entry') {
        const position = await tx.trackedPosition.findFirst({
          where: {
            id: proposal.trackedPositionId,
            tradingAccountId: args.tradingAccountId,
            broker: currentOrder.broker,
            symbol: currentOrder.symbol,
          },
        });
        if (!position) {
          throw new Error(
            `Matched position ${proposal.trackedPositionId} no longer satisfies ownership.`
          );
        }
      }

      const linkedAt = new Date();
      const shouldPropagatePosition =
        proposal.kind === 'filled_entry' ||
        (proposal.kind === 'filled_non_entry' &&
          proposal.trackedPositionId !== null);
      await tx.brokerOrder.update({
        where: { id: currentOrder.id },
        data: {
          status: proposal.brokerOrderStatus,
          ...(shouldPropagatePosition && {
            trackedPositionId: proposal.trackedPositionId,
          }),
        },
      });
      await tx.orderIntent.update({
        where: { id: currentOrder.orderIntentId },
        data: {
          status: proposal.orderIntentStatus,
          ...(shouldPropagatePosition && {
            trackedPositionId: proposal.trackedPositionId,
          }),
        },
      });
      if (shouldPropagatePosition) {
        await tx.brokerActivity.updateMany({
          where: {
            brokerOrderRecordId: currentOrder.id,
            orderIntentId: currentOrder.orderIntentId,
            tradingAccountId: args.tradingAccountId,
            activityType: 'FILL',
            trackedPositionId: null,
          },
          data: {
            trackedPositionId: proposal.trackedPositionId,
            trackedPositionLinkSource: HISTORICAL_ORDER_REPAIR_LINK_SOURCE,
            trackedPositionLinkedAt: linkedAt,
          },
        });
      }
      await tx.systemEvent.create({
        data: {
          type: 'historical_order_lifecycle.repaired',
          entityType: 'brokerOrder',
          entityId: String(currentOrder.id),
          tradingAccountId: args.tradingAccountId,
          message: `Repaired historical lifecycle for ${currentOrder.symbol}.`,
          payloadJson: {
            tradingAccountId: args.tradingAccountId,
            orderIntentId: currentOrder.orderIntentId,
            brokerOrderRecordId: currentOrder.id,
            brokerOrderId: currentOrder.brokerOrderId,
            clientOrderId: currentOrder.clientOrderId,
            symbol: currentOrder.symbol,
            oldStatuses: {
              brokerOrder: currentOrder.status,
              orderIntent: currentOrder.orderIntent.status,
            },
            newStatuses: {
              brokerOrder: proposal.brokerOrderStatus,
              orderIntent: proposal.orderIntentStatus,
            },
            trackedPositionId: proposal.trackedPositionId,
            evidenceClassification: proposal.evidence,
            matchingEvidence: row.classifications,
            repairRunId: args.runId,
            actor: 'script:historical-order-lifecycle-repair',
          } satisfies Prisma.InputJsonValue,
        },
      });
      repaired.push({
        orderIntentId: currentOrder.orderIntentId,
        brokerOrderRecordId: currentOrder.id,
        trackedPositionId: proposal.trackedPositionId,
        oldBrokerOrderStatus: currentOrder.status,
        newBrokerOrderStatus: proposal.brokerOrderStatus,
        oldOrderIntentStatus: currentOrder.orderIntent.status,
        newOrderIntentStatus: proposal.orderIntentStatus,
      });
    }
    await tx.systemEvent.create({
      data: {
        type: 'historical_order_lifecycle.repair_run_completed',
        entityType: 'tradingAccount',
        entityId: String(args.tradingAccountId),
        tradingAccountId: args.tradingAccountId,
        message: `Historical lifecycle repair completed for ${repaired.length} groups.`,
        payloadJson: {
          tradingAccountId: args.tradingAccountId,
          repairRunId: args.runId,
          repairedCount: repaired.length,
          actor: 'script:historical-order-lifecycle-repair',
        },
      },
    });
    return repaired;
  });
}

export async function repairHistoricalOrderLifecycle(args: {
  tradingAccountId: number;
  apply?: boolean;
  confirmation?: string;
}) {
  if (args.apply && args.confirmation !== HISTORICAL_ORDER_REPAIR_CONFIRMATION) {
    throw new Error(
      `Apply mode requires --confirmation="${HISTORICAL_ORDER_REPAIR_CONFIRMATION}".`
    );
  }
  const report = await buildReport(args.tradingAccountId);
  if (!args.apply) return { mode: 'dry-run' as const, ...report };
  if (!report.safeToApply) {
    return { mode: 'apply' as const, ...report, repaired: [] };
  }

  const runId = randomUUID();
  const lock = await withTradingAccountWorkflowLock({
    tradingAccountId: args.tradingAccountId,
    workflowKey: 'historical-order-lifecycle-repair',
    processInstanceId: runId,
    execute: () =>
      applyProposals({
        tradingAccountId: args.tradingAccountId,
        runId,
        proposals: report.proposals,
      }),
  });
  if (lock.outcome !== 'ACQUIRED_AND_COMPLETED') {
    if (lock.outcome === 'WORKFLOW_ERROR' || lock.outcome === 'LOCK_ERROR') {
      throw lock.error;
    }
    throw new Error(`Repair lock was not acquired for account ${args.tradingAccountId}.`);
  }
  return {
    mode: 'apply' as const,
    runId,
    ...report,
    repaired: lock.value,
  };
}
