import type { Prisma } from '@prisma/client';

import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { closePosition } from './close-position.service.js';
import { createSystemEvent } from './system-event.service.js';
import {
  ensurePositionExitState,
  markTrailingStopOrderSubmitFailed,
  unlockTrailingStopExitState,
} from './position-exit-state.service.js';
import { submitTrailingStopExitOrder } from './trailing-stop-exit.service.js';
import {
  enumerateLifecycleAccounts,
  type LifecycleAccountEligibility,
} from './lifecycle-account-eligibility.service.js';
import { syncProtectiveOrdersForAccount } from './protective-order-sync.service.js';
import { runTradingAccountWorkflow } from './trading-account-workflow-runner.service.js';
import { ACCOUNT_WORKFLOW_LOCK_FAMILIES } from './trading-account-workflow-lock.service.js';

export type ExitEvaluationCounts = {
  positionsEvaluated: number;
  positionsSkipped: number;
  exitSignalsTriggered: number;
  closeIntentsCreated: number;
  protectiveOrdersSynchronized: number;
  blockedExits: number;
  failedPositions: number;
};

export type ExitEvaluationAccountResult = {
  workflow: 'exit_evaluation';
  account: LifecycleAccountEligibility;
  outcome: 'PROCESSED' | 'SKIPPED' | 'CREDENTIALS_UNAVAILABLE' | 'FAILED';
  counts: ExitEvaluationCounts;
  failures: Array<{ trackedPositionId: number; error: string }>;
  error?: string;
};

function emptyCounts(): ExitEvaluationCounts {
  return {
    positionsEvaluated: 0,
    positionsSkipped: 0,
    exitSignalsTriggered: 0,
    closeIntentsCreated: 0,
    protectiveOrdersSynchronized: 0,
    blockedExits: 0,
    failedPositions: 0,
  };
}

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown exit evaluation error.';
}

function errorToPayloadJson(error: unknown): Prisma.InputJsonValue {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
}

function isUnlockTrailingProfile(exitProfile: { exitMode: string }) {
  return exitProfile.exitMode === 'unlock_trailing_stop';
}

export async function evaluateExitsForAccount(
  tradingAccountId: number
): Promise<{
  counts: ExitEvaluationCounts;
  failures: Array<{ trackedPositionId: number; error: string }>;
}> {
  const positions = await prisma.trackedPosition.findMany({
    where: { status: { in: ['open', 'closing'] }, tradingAccountId },
    include: {
      exitState: true,
      subscription: {
        include: { exitProfile: true },
      },
      tradingAccountSubscription: {
        include: {
          subscription: {
            include: { exitProfile: true },
          },
        },
      },
    },
    orderBy: { id: 'asc' },
  });
  const counts = emptyCounts();
  const failures: Array<{ trackedPositionId: number; error: string }> = [];
  const protectiveSync = await syncProtectiveOrdersForAccount(tradingAccountId);
  counts.protectiveOrdersSynchronized = protectiveSync.synchronized;
  counts.failedPositions += protectiveSync.failed;
  failures.push(
    ...protectiveSync.failures.map((failure) => ({
      trackedPositionId: failure.trackedPositionId,
      error: failure.error,
    }))
  );

  for (const position of positions) {
    try {
      counts.positionsEvaluated += 1;

      if (position.tradingAccountId !== tradingAccountId) {
        throw new Error(
          `TrackedPosition ${position.id} account attribution does not match coordinator account ${tradingAccountId}.`
        );
      }

      const assignment = position.tradingAccountSubscription;
      if (
        !assignment ||
        assignment.tradingAccountId !== tradingAccountId ||
        assignment.subscriptionId !== position.subscriptionId
      ) {
        throw new Error(
          `TrackedPosition ${position.id} has missing or inconsistent account assignment attribution.`
        );
      }

      const exitProfile = assignment.subscription.exitProfile;
      if (!exitProfile) {
        counts.positionsSkipped += 1;
        continue;
      }

      // Existing protective orders remain broker-owned lifecycle work. Their
      // status synchronization is performed by submitted-order synchronization,
      // independently of whether this assignment still permits new exits.
      if (position.exitState?.trailBrokerOrderId) {
        counts.positionsSkipped += 1;
        continue;
      }

      if (position.status === 'closing') {
        counts.positionsSkipped += 1;
        continue;
      }

      if (!assignment.enabled || !assignment.exitsEnabled) {
        counts.positionsSkipped += 1;
        counts.blockedExits += 1;
        continue;
      }

      const pnlPct = position.unrealizedPnLPct ?? 0;

      if (isUnlockTrailingProfile(exitProfile)) {
        let exitState =
          position.exitState ?? (await ensurePositionExitState(position.id));
        const targetPct = exitState.targetPct ?? exitProfile.targetPct;
        const trailingStopPct =
          exitState.trailingStopPct ?? exitProfile.trailingStopPct;

        if (targetPct === null || trailingStopPct === null) {
          counts.positionsSkipped += 1;
          continue;
        }

        if (!exitState.targetUnlocked && pnlPct >= targetPct / 100) {
          exitState = await unlockTrailingStopExitState({
            trackedPositionId: position.id,
            currentPrice: position.currentPrice,
            pnlPct,
            targetPct,
            trailingStopPct,
          });
          counts.exitSignalsTriggered += 1;

          await createSystemEvent({
            type: 'exit.target_unlocked',
            entityType: 'trackedPosition',
            entityId: position.id,
            tradingAccountId,
            message: `${position.symbol} reached target unlock for trailing stop exit.`,
            payloadJson: {
              symbol: position.symbol,
              pnlPct,
              currentPrice: position.currentPrice,
              targetPct,
              trailingStopPct,
              exitProfileKey: exitProfile.key,
            } as Prisma.InputJsonValue,
          });
        }

        if (
          exitState.targetUnlocked &&
          !exitState.trailBrokerOrderId
        ) {
          try {
            await submitTrailingStopExitOrder(tradingAccountId, position.id);
            counts.closeIntentsCreated += 1;
          } catch (error) {
            const payloadJson = errorToPayloadJson(error);
            await markTrailingStopOrderSubmitFailed(position.id, payloadJson);
            await createSystemEvent({
              type: 'exit.trailing_stop_submit_failed',
              entityType: 'trackedPosition',
              entityId: position.id,
              tradingAccountId,
              message: `${position.symbol} trailing stop exit order submission failed.`,
              payloadJson: {
                symbol: position.symbol,
                error: payloadJson,
              } as Prisma.InputJsonValue,
            });
            throw error;
          }
        }

        continue;
      }

      const takeProfit =
        exitProfile.targetPct !== null &&
        pnlPct >= exitProfile.targetPct / 100;
      const stopLoss =
        exitProfile.stopLossPct !== null &&
        pnlPct <= -(exitProfile.stopLossPct / 100);
      if (!takeProfit && !stopLoss) {
        continue;
      }

      const reason = stopLoss ? 'stop_loss' : 'take_profit';
      counts.exitSignalsTriggered += 1;
      await closePosition(position.id);
      counts.closeIntentsCreated += 1;
      await createSystemEvent({
        type: 'exit.triggered',
        entityType: 'trackedPosition',
        entityId: position.id,
        tradingAccountId,
        payloadJson: {
          symbol: position.symbol,
          reason,
          pnlPct,
        } as Prisma.InputJsonValue,
      });
    } catch (error) {
      counts.failedPositions += 1;
      failures.push({
        trackedPositionId: position.id,
        error: sanitizeError(error),
      });
      logger.error(
        {
          workflow: 'exit_evaluation',
          tradingAccountId,
          trackedPositionId: position.id,
          error: sanitizeError(error),
        },
        'Exit evaluation failed for one tracked position.'
      );
    }
  }

  return { counts, failures };
}

export async function evaluateExitsForEligibleAccounts() {
  const accounts = await enumerateLifecycleAccounts('exit_evaluation');
  const results: ExitEvaluationAccountResult[] = [];

  for (const account of accounts) {
    if (!account.eligible) {
      const outcome =
        account.reason === 'credentials_unavailable_with_exposure'
          ? 'CREDENTIALS_UNAVAILABLE'
          : 'SKIPPED';
      results.push({
        workflow: 'exit_evaluation',
        account,
        outcome,
        counts: emptyCounts(),
        failures: [],
      });

      if (outcome === 'CREDENTIALS_UNAVAILABLE') {
        try {
          await createSystemEvent({
            type: 'exit.credentials_unavailable_with_exposure',
            entityType: 'tradingAccount',
            entityId: account.tradingAccountId,
            tradingAccountId: account.tradingAccountId,
            message: `Exit evaluation cannot safely access broker credentials for ${account.displayName}.`,
            payloadJson: {
              workflow: 'exit_evaluation',
              environment: account.environment,
              activePositions: account.exposureSummary.activePositions,
              nonterminalOrders: account.exposureSummary.nonterminalOrders,
            } as Prisma.InputJsonValue,
          });
        } catch (error) {
          logger.error(
            {
              workflow: 'exit_evaluation',
              tradingAccountId: account.tradingAccountId,
              error: sanitizeError(error),
            },
            'Failed to persist credentials-unavailable exit event.'
          );
        }
      }
      logger[outcome === 'CREDENTIALS_UNAVAILABLE' ? 'error' : 'info'](
        {
          workflow: 'exit_evaluation',
          tradingAccountId: account.tradingAccountId,
          displayName: account.displayName,
          environment: account.environment,
          outcome,
          reason: account.reason,
        },
        'Exit evaluation account outcome.'
      );
      continue;
    }

    try {
      const run = await runTradingAccountWorkflow({
        tradingAccountId: account.tradingAccountId,
        workerKey: 'exit_evaluation',
        lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.EXIT_EVALUATION,
        execute: () => evaluateExitsForAccount(account.tradingAccountId),
        classify: (result) => result.counts.failedPositions > 0
          ? {
              outcome: 'failure',
              error: new Error(
                `${result.counts.failedPositions} position exit evaluation(s) failed.`
              ),
              errorCode: 'EXIT_EVALUATION_ITEM_FAILURE',
              summary: result.counts,
            }
          : {
              outcome: 'success',
              workSucceeded: result.counts.positionsEvaluated > 0,
              summary: result.counts,
            },
      });
      if (run.outcome === 'FAILED') {
        if (run.value !== undefined) {
          results.push({
            workflow: 'exit_evaluation',
            account,
            outcome: 'FAILED',
            ...run.value,
          });
          continue;
        }
        throw run.error;
      }
      if (run.outcome !== 'PROCESSED') {
        results.push({
          workflow: 'exit_evaluation', account, outcome: 'SKIPPED',
          counts: emptyCounts(), failures: [],
        });
        continue;
      }
      const evaluation = run.value;
      const outcome =
        evaluation.counts.failedPositions > 0 ? 'FAILED' : 'PROCESSED';
      results.push({
        workflow: 'exit_evaluation',
        account,
        outcome,
        ...evaluation,
      });
      logger[outcome === 'FAILED' ? 'error' : 'info'](
        {
          workflow: 'exit_evaluation',
          tradingAccountId: account.tradingAccountId,
          displayName: account.displayName,
          environment: account.environment,
          outcome,
          ...evaluation.counts,
        },
        'Exit evaluation account outcome.'
      );
    } catch (error) {
      results.push({
        workflow: 'exit_evaluation',
        account,
        outcome: 'FAILED',
        counts: emptyCounts(),
        failures: [],
        error: sanitizeError(error),
      });
    }
  }

  return {
    workflow: 'exit_evaluation' as const,
    processedAccounts: results.filter((item) => item.outcome === 'PROCESSED').length,
    failedAccounts: results.filter((item) => item.outcome === 'FAILED').length,
    credentialUnavailableAccounts: results.filter(
      (item) => item.outcome === 'CREDENTIALS_UNAVAILABLE'
    ).length,
    skippedAccounts: results.filter((item) => item.outcome === 'SKIPPED').length,
    results,
  };
}

// Compatibility name for callers while the lifecycle worker migrates to the
// explicit coordinator.
export const evaluateExits = evaluateExitsForEligibleAccounts;
