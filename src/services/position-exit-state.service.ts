import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

type UnlockTrailingStopArgs = {
  trackedPositionId: number;
  currentPrice: number;
  pnlPct: number;
  targetPct: number;
  trailingStopPct: number;
};

type MarkTrailingStopOrderSubmittedArgs = {
  trackedPositionId: number;
  broker: string;
  brokerOrderId: string;
  clientOrderId: string;
  orderStatus: string;
  rawBrokerJson: Prisma.InputJsonValue;
};

function calculateTrailStopPrice(
  highWaterMark: number,
  trailingStopPct: number
): number {
  return highWaterMark * (1 - trailingStopPct / 100);
}

async function getPositionWithExitProfile(trackedPositionId: number) {
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

  return position;
}

export async function ensurePositionExitState(trackedPositionId: number) {
  const existing = await prisma.positionExitState.findUnique({
    where: { trackedPositionId },
  });

  if (existing) {
    return existing;
  }

  const position = await getPositionWithExitProfile(trackedPositionId);
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

export async function resetPositionExitStateForOpenPosition(
  trackedPositionId: number
) {
  const position = await getPositionWithExitProfile(trackedPositionId);
  const exitProfile = position.subscription?.exitProfile;

  return prisma.positionExitState.upsert({
    where: { trackedPositionId },
    create: {
      trackedPositionId,
      status: 'watching',
      targetUnlocked: false,
      exitProfileKey: exitProfile?.key ?? null,
      exitMode: exitProfile?.exitMode ?? null,
      takeProfitBehavior: exitProfile?.takeProfitBehavior ?? null,
      targetPct: exitProfile?.targetPct ?? null,
      trailingStopPct: exitProfile?.trailingStopPct ?? null,
    },
    update: {
      status: 'watching',
      targetUnlocked: false,
      targetUnlockedAt: null,
      targetUnlockedPrice: null,
      targetUnlockedPnlPct: null,
      highWaterMark: null,
      trailStopPrice: null,
      exitProfileKey: exitProfile?.key ?? null,
      exitMode: exitProfile?.exitMode ?? null,
      takeProfitBehavior: exitProfile?.takeProfitBehavior ?? null,
      targetPct: exitProfile?.targetPct ?? null,
      trailingStopPct: exitProfile?.trailingStopPct ?? null,
      trailBroker: null,
      trailBrokerOrderId: null,
      trailClientOrderId: null,
      trailOrderStatus: null,
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

export async function markTrailingStopOrderSubmitted(
  args: MarkTrailingStopOrderSubmittedArgs
) {
  return prisma.positionExitState.update({
    where: { trackedPositionId: args.trackedPositionId },
    data: {
      status: 'trailing_stop_submitted',
      trailBroker: args.broker,
      trailBrokerOrderId: args.brokerOrderId,
      trailClientOrderId: args.clientOrderId,
      trailOrderStatus: args.orderStatus,
      rawBrokerJson: args.rawBrokerJson,
    },
  });
}

export async function markTrailingStopOrderSubmitFailed(
  trackedPositionId: number,
  payloadJson: Prisma.InputJsonValue
) {
  return prisma.positionExitState.update({
    where: { trackedPositionId },
    data: {
      status: 'trailing_stop_submit_failed',
      trailOrderStatus: 'submit_failed',
      rawBrokerJson: payloadJson,
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