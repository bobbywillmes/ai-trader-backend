import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { closePosition } from './close-position.service.js';
import { createSystemEvent } from './system-event.service.js';
import {
  ensurePositionExitState,
  markTrailingStopOrderSubmitFailed,
  unlockTrailingStopExitState,
} from './position-exit-state.service.js';
import { submitTrailingStopExitOrder } from './trailing-stop-exit.service.js';
import { submitNativeTrailingStopForTrackedPosition } from './trailing-stop.service.js';

function isUnlockTrailingProfile(exitProfile: { exitMode: string }) {
  return exitProfile.exitMode === 'unlock_trailing_stop';
}

function errorToPayloadJson(error: unknown): Prisma.InputJsonValue {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}

function hasReachedUnlockTarget(args: {
  pnlPct: number;
  targetPct: number | null;
}) {
  if (args.targetPct === null || args.targetPct === undefined) {
    return false;
  }

  return args.pnlPct >= args.targetPct / 100;
}

function shouldAttemptTrailingStopSubmit(position: {
  trailingStopOrderId: string | null;
  trailingStopStatus: string | null;
}) {
  if (position.trailingStopOrderId) {
    return false;
  }

  if (position.trailingStopStatus === 'submit_failed') {
    return false;
  }

  return true;
}

export async function evaluateExits() {
  const openPositions = await prisma.trackedPosition.findMany({
    where: { status: 'open' },
    include: {
      exitState: true,
      subscription: {
        include: {
          exitProfile: true,
        },
      },
    },
  });

  for (const position of openPositions) {
    const exitProfile = position.subscription?.exitProfile;
    if (!exitProfile) continue;

    const pnlPct = position.unrealizedPnLPct ?? 0;

    if (isUnlockTrailingProfile(exitProfile)) {
      let exitState =
        position.exitState ?? (await ensurePositionExitState(position.id));

      const targetPct = exitState.targetPct ?? exitProfile.targetPct;
      const trailingStopPct =
        exitState.trailingStopPct ?? exitProfile.trailingStopPct;

      if (
        targetPct === null ||
        targetPct === undefined ||
        trailingStopPct === null ||
        trailingStopPct === undefined
      ) {
        continue;
      }

      const hasReachedTarget = pnlPct >= targetPct / 100;

      if (!exitState.targetUnlocked && hasReachedTarget) {
        exitState = await unlockTrailingStopExitState({
          trackedPositionId: position.id,
          currentPrice: position.currentPrice,
          pnlPct,
          targetPct,
          trailingStopPct,
        });

        await createSystemEvent({
          type: 'exit.target_unlocked',
          entityType: 'trackedPosition',
          entityId: position.id,
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

        console.log(
          `Exit target unlocked for ${position.symbol}: ${targetPct}% target -> ${trailingStopPct}% trail`
        );
      }

      const shouldSubmitTrailingStop =
        exitState.targetUnlocked &&
        !exitState.trailBrokerOrderId &&
        exitState.trailOrderStatus !== 'submit_failed';

      if (shouldSubmitTrailingStop) {
        try {
          await submitTrailingStopExitOrder(position.id);
        } catch (error) {
          const payloadJson = errorToPayloadJson(error);

          await markTrailingStopOrderSubmitFailed(position.id, payloadJson);

          await createSystemEvent({
            type: 'exit.trailing_stop_submit_failed',
            entityType: 'trackedPosition',
            entityId: position.id,
            message: `${position.symbol} trailing stop exit order submission failed.`,
            payloadJson: {
              symbol: position.symbol,
              error: payloadJson,
            } as Prisma.InputJsonValue,
          });

          console.error(
            `Trailing stop submit failed for ${position.symbol}:`,
            error
          );
        }
      }

      continue;
    }

    let shouldExit = false;
    let reason = '';

    // If exitMode is unlock trailing stop
  if (isUnlockTrailingProfile(exitProfile)) {
    // For unlock-trailing profiles, the target percentage does NOT mean:
    // "sell when this target is reached."
    //
    // Instead, it means:
    // "when this target is reached, submit a native Alpaca trailing-stop order."
    const targetPct = exitProfile.targetPct;
    const trailingStopPct = exitProfile.trailingStopPct;

    // If the profile is missing either the unlock target or trailing-stop percent,
    // we cannot safely process this exit profile.
    //
    // Skip this position for now rather than risking a bad broker order.
    if (
      targetPct === null ||
      targetPct === undefined ||
      trailingStopPct === null ||
      trailingStopPct === undefined
    ) {
      continue;
    }

    // Check whether the current open position has reached the unlock threshold.
    //
    // Example:
    // - targetPct = 1.0
    // - pnlPct must be >= 0.01
    //
    // The helper handles the conversion from stored percent value to decimal form.
    const reachedUnlockTarget = hasReachedUnlockTarget({
      pnlPct,
      targetPct,
    });

    // If the position has not reached the unlock target yet,
    // do nothing and keep the position open.
    //
    // The backend will check again on the next worker cycle.
    if (!reachedUnlockTarget) {
      continue;
    }

    // At this point, the position has reached the unlock target.
    //
    // Before submitting anything to Alpaca, make sure we have not already handed
    // this position off to a native trailing-stop order.
    //
    // This prevents duplicate trailing-stop sell orders.
    if (!shouldAttemptTrailingStopSubmit(position)) {
      continue;
    }

    try {
      // Submit the native Alpaca trailing-stop sell order.
      //
      // The trailing-stop service handles:
      // - claiming the position
      // - generating/storing a clientOrderId
      // - checking Alpaca for an existing order with that clientOrderId
      // - submitting the trailing_stop order if needed
      // - saving Alpaca order details back to TrackedPosition
      // - logging a SystemEvent
      const result = await submitNativeTrailingStopForTrackedPosition(
        position.id,
        position.currentPrice
      );

      // Keep a simple console message for worker visibility during local testing.
      console.log(
        `Trailing stop handoff for ${position.symbol}: ${result.status}`
      );
    } catch (error) {
      // The trailing-stop service logs a SystemEvent on failure.
      //
      // This console error is mainly for local/dev visibility while watching
      // the worker process.
      console.error(
        `Trailing stop handoff failed for ${position.symbol}:`,
        error
      );
    }

    // Important:
    //
    // Stop processing this position after the unlock-trailing logic runs.
    //
    // Without this continue, the evaluator could fall through into the older
    // fixed-target / stop-loss logic and accidentally close the position at the
    // unlock target instead of letting Alpaca manage the trailing stop.
    continue;
  }

    // Take profit
    if (exitProfile.targetPct && pnlPct >= exitProfile.targetPct / 100) {
      shouldExit = true;
      reason = 'take_profit';
    }

    // Stop loss
    if (exitProfile.stopLossPct && pnlPct <= -(exitProfile.stopLossPct / 100)) {
      shouldExit = true;
      reason = 'stop_loss';
    }

    if (!shouldExit) continue;

    console.log(`Exit triggered for ${position.symbol} (${reason})`);

    await closePosition(position.symbol);

    await createSystemEvent({
      type: 'exit.triggered',
      entityType: 'trackedPosition',
      entityId: position.id,
      payloadJson: {
        symbol: position.symbol,
        reason,
        pnlPct,
      } as Prisma.InputJsonValue,
    });
  }
}