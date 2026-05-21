import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

type UnlockTrailingStopArgs = {
  trackedPositionId: number;
  currentPrice: number;
  pnlPct: number;
  targetPct: number;
  trailingStopPct: number;
};

function calculateTrailStopPrice(
  highWaterMark: number,
  trailingStopPct: number
): number {
  return highWaterMark * (1 - trailingStopPct / 100);
}

export async function ensurePositionExitState(trackedPositionId: number) {
  const existing = await prisma.positionExitState.findUnique({
    where: { trackedPositionId },
  });

  if (existing) {
    return existing;
  }

  const position = await prisma.trackedPosition.findUnique({
    where: { id: trackedPositionId },
    include: {
      subscription: {
        include: {
          exitProfile: true,
        },
      },
    },
  });

  if (!position) {
    throw new Error(`Tracked position ${trackedPositionId} was not found.`);
  }

  const exitProfile = position.subscription?.exitProfile;

  return prisma.positionExitState.create({
    data: {
      trackedPositionId,
      status: 'watching',
      exitProfileKey: exitProfile?.key ?? null,
      exitMode: exitProfile?.exitMode ?? null,
      takeProfitBehavior: exitProfile?.takeProfitBehavior ?? null,
      targetPct: exitProfile?.targetPct ?? null,
      trailingStopPct: exitProfile?.trailingStopPct ?? null,
    },
  });
}

export async function unlockTrailingStopExitState(
  args: UnlockTrailingStopArgs
) {
  const highWaterMark = args.currentPrice;
  const trailStopPrice = calculateTrailStopPrice(
    highWaterMark,
    args.trailingStopPct
  );

  return prisma.positionExitState.update({
    where: { trackedPositionId: args.trackedPositionId },
    data: {
      status: 'target_unlocked',
      targetUnlocked: true,
      targetUnlockedAt: new Date(),
      targetUnlockedPrice: args.currentPrice,
      targetUnlockedPnlPct: args.pnlPct,
      highWaterMark,
      trailStopPrice,
      targetPct: args.targetPct,
      trailingStopPct: args.trailingStopPct,
    },
  });
}

export async function markPositionExitStateClosed(
  trackedPositionId: number,
  payloadJson?: Prisma.InputJsonValue
) {
  const createData: Prisma.PositionExitStateUncheckedCreateInput = {
    trackedPositionId,
    status: 'closed',
    ...(payloadJson !== undefined ? { rawBrokerJson: payloadJson } : {}),
  };

  const updateData: Prisma.PositionExitStateUncheckedUpdateInput = {
    status: 'closed',
    ...(payloadJson !== undefined ? { rawBrokerJson: payloadJson } : {}),
  };

  return prisma.positionExitState.upsert({
    where: { trackedPositionId },
    create: createData,
    update: updateData,
  });
}