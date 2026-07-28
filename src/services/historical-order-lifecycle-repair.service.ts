import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getTradingAccountEntryRiskUsage } from './trading-account-entry-risk-usage.service.js';
import { representsPendingEntryExposure } from './trading-account-entry-risk-limits.service.js';
import { normalizeBrokerOrderStatus } from './broker-order-lifecycle-status.service.js';
import {
  createHistoricalLifecycleStateFingerprint,
  diagnoseHistoricalOrderLifecycle,
  matchHistoricalEntryPosition,
  validateExistingHistoricalPositionLink,
} from './historical-order-lifecycle-diagnostic.service.js';
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
  const existingPositionIds = new Set(
    [
      row.orderIntentTrackedPositionId,
      row.brokerOrderTrackedPositionId,
      ...row.activityTrackedPositionIds,
    ].filter((id): id is number => id !== null)
  );
  if (
    row.classifications.includes('FULL_FILL_LOCAL_EVIDENCE') &&
    row.classifications.includes('POSITION_LINK_EXISTING_VALID') &&
    row.validatedExistingTrackedPositionId !== null &&
    row.side.toLowerCase() === 'buy'
  ) {
    return {
      kind: 'filled_entry',
      orderIntentId: row.orderIntentId,
      brokerOrderRecordId: row.brokerOrderRecordId,
      trackedPositionId: row.validatedExistingTrackedPositionId,
      brokerOrderStatus: 'filled',
      orderIntentStatus: 'filled',
      evidence: [
        'FULL_FILL_LOCAL_EVIDENCE',
        'POSITION_LINK_EXISTING_VALID',
      ],
    };
  }
  if (
    row.classifications.includes('FULL_FILL_LOCAL_EVIDENCE') &&
    row.classifications.includes('POSITION_LINK_EXACT') &&
    row.matchedTrackedPositionId !== null &&
    row.side.toLowerCase() === 'buy' &&
    [...existingPositionIds].every(
      (id) => id === row.matchedTrackedPositionId
    )
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
    return {
      kind: 'filled_non_entry',
      orderIntentId: row.orderIntentId,
      brokerOrderRecordId: row.brokerOrderRecordId,
      trackedPositionId:
        existingPositionIds.size === 1
          ? [...existingPositionIds][0]!
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

async function buildReportFromDiagnostic(
  tradingAccountId: number,
  diagnostic: Awaited<ReturnType<typeof diagnoseHistoricalOrderLifecycle>>
) {
  const before = await slotUsage(tradingAccountId);
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

async function buildReport(tradingAccountId: number) {
  const diagnostic = await diagnoseHistoricalOrderLifecycle({
    tradingAccountId,
  });
  return buildReportFromDiagnostic(tradingAccountId, diagnostic);
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
        include: {
          orderIntent: true,
          brokerActivities: true,
        },
      });
      if (!currentOrder || currentOrder.orderIntentId !== proposal.orderIntentId) {
        throw new Error(
          `Lifecycle group ${proposal.brokerOrderRecordId} changed after diagnosis.`
        );
      }
      if (
        createHistoricalLifecycleStateFingerprint(currentOrder) !==
        row.localStateFingerprint
      ) {
        throw new Error(
          `Lifecycle group ${proposal.brokerOrderRecordId} changed after final validation.`
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
        const existingLinkEvidence = proposal.evidence.includes(
          'POSITION_LINK_EXISTING_VALID'
        );
        const positionStillValid = existingLinkEvidence
          ? validateExistingHistoricalPositionLink({
              existingPositionIds: [
                currentOrder.orderIntent.trackedPositionId,
                currentOrder.trackedPositionId,
                ...currentOrder.brokerActivities.map(
                  (activity) => activity.trackedPositionId
                ),
              ].filter((id): id is number => id !== null),
              tradingAccountId: currentOrder.tradingAccountId,
              broker: currentOrder.broker,
              symbol: currentOrder.symbol,
              subscriptionId: currentOrder.orderIntent.subscriptionId,
              tradingAccountSubscriptionId:
                currentOrder.orderIntent.tradingAccountSubscriptionId,
              positions: [position],
            }).status === 'valid'
          : matchHistoricalEntryPosition(
              {
                tradingAccountId: currentOrder.tradingAccountId,
                broker: currentOrder.broker,
                symbol: currentOrder.symbol,
                side: currentOrder.side,
                qty: currentOrder.orderIntent.qty,
                fillPrice: row.fillEvidence.weightedAveragePrice,
                fillTime: row.fillEvidence.completionTime
                  ? new Date(row.fillEvidence.completionTime)
                  : null,
                subscriptionId: currentOrder.orderIntent.subscriptionId,
                tradingAccountSubscriptionId:
                  currentOrder.orderIntent.tradingAccountSubscriptionId,
              },
              [position]
            ).status === 'exact';
        if (!positionStillValid) {
          throw new Error(
            `Matched position ${proposal.trackedPositionId} changed after final validation.`
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

function withInitialBrokerEvidence(
  finalDiagnostic: Awaited<
    ReturnType<typeof diagnoseHistoricalOrderLifecycle>
  >,
  initialDiagnostic: Awaited<
    ReturnType<typeof diagnoseHistoricalOrderLifecycle>
  >
) {
  const initialById = new Map(
    initialDiagnostic.candidates.map((row) => [row.brokerOrderRecordId, row])
  );
  return {
    ...finalDiagnostic,
    candidates: finalDiagnostic.candidates.map((row) => {
      const initial = initialById.get(row.brokerOrderRecordId);
      if (!initial?.brokerLookup || !('status' in initial.brokerLookup)) {
        return row;
      }
      if (
        initial.brokerLookup.id !== row.brokerOrderId ||
        initial.brokerLookup.clientOrderId !== row.clientOrderId
      ) {
        throw new Error(
          `Broker identity evidence changed for lifecycle group ${row.brokerOrderRecordId}.`
        );
      }
      return {
        ...row,
        brokerLookup: initial.brokerLookup,
        classifications: Array.from(
          new Set([
            ...row.classifications,
            ...initial.classifications.filter(
              (classification) =>
                classification === 'TERMINAL_BROKER_CONFIRMED' ||
                classification === 'NONTERMINAL_BROKER_CONFIRMED'
            ),
          ])
        ),
      };
    }),
  };
}

export function assertApplyReportUnchanged(args: {
  initial: Awaited<ReturnType<typeof buildReport>>;
  final: Awaited<ReturnType<typeof buildReport>>;
}) {
  const finalById = new Map(
    args.final.proposals.map((item) => [
      item.proposal.brokerOrderRecordId,
      item,
    ])
  );
  for (const initialItem of args.initial.proposals) {
    const finalItem = finalById.get(
      initialItem.proposal.brokerOrderRecordId
    );
    if (
      !finalItem ||
      finalItem.row.localStateFingerprint !==
        initialItem.row.localStateFingerprint ||
      JSON.stringify(finalItem.proposal) !==
        JSON.stringify(initialItem.proposal)
    ) {
      throw new Error(
        `Lifecycle group ${initialItem.proposal.brokerOrderRecordId} changed after broker evidence was gathered.`
      );
    }
  }
  if (finalById.size !== args.initial.proposals.length) {
    throw new Error(
      'Historical lifecycle proposals changed after broker evidence was gathered.'
    );
  }
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
  const initialReport = await buildReport(args.tradingAccountId);
  if (!args.apply) return { mode: 'dry-run' as const, ...initialReport };
  if (!initialReport.safeToApply) {
    return { mode: 'apply' as const, ...initialReport, repaired: [] };
  }

  const runId = randomUUID();
  const lock = await withTradingAccountWorkflowLock({
    tradingAccountId: args.tradingAccountId,
    workflowKey: 'historical-order-lifecycle-repair',
    processInstanceId: runId,
    execute: async () => {
      const finalLocalDiagnostic = await diagnoseHistoricalOrderLifecycle({
        tradingAccountId: args.tradingAccountId,
        openOrders: [],
        lookupBudget: 0,
      });
      const finalDiagnostic = withInitialBrokerEvidence(
        finalLocalDiagnostic,
        initialReport.diagnostic
      );
      const finalReport = await buildReportFromDiagnostic(
        args.tradingAccountId,
        finalDiagnostic
      );
      assertApplyReportUnchanged({
        initial: initialReport,
        final: finalReport,
      });
      const repaired = await applyProposals({
        tradingAccountId: args.tradingAccountId,
        runId,
        proposals: finalReport.proposals,
      });
      return { report: finalReport, repaired };
    },
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
    ...lock.value.report,
    repaired: lock.value.repaired,
  };
}
