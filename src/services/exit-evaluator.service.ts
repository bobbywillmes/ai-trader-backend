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