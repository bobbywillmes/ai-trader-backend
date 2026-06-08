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

type SyncTrailingStopOrderStatusArgs = {
  clientOrderId: string;
  brokerOrderId?: string;
  orderStatus: string;
  rawBrokerJson: Prisma.InputJsonValue;
};

function calculateTrailStopPrice(
  highWaterMark: number,
  trailingStopPct: number
): number {
  return highWaterMark * (1 - trailingStopPct / 100);
}

function mapTrailingStopOrderStatusToExitStateStatus(orderStatus: string) {
  switch (orderStatus) {
    case 'filled':
      return 'trailing_stop_filled';
    case 'canceled':
      return 'trailing_stop_canceled';
    case 'expired':
      return 'trailing_stop_expired';
    case 'rejected':
      return 'trailing_stop_rejected';
    default:
      return 'trailing_stop_submitted';
  }
}

function buildAttentionRequiredData(args: {
  code: string;
  message: string;
}): Prisma.PositionExitStateUncheckedUpdateInput {
  return {
    attentionRequired: true,
    attentionCode: args.code,
    attentionMessage: args.message,
    attentionAt: new Date(),
    attentionClearedAt: null,
  };
}

function buildAttentionClearedData(): Prisma.PositionExitStateUncheckedUpdateInput {
  return {
    attentionRequired: false,
    attentionCode: null,
    attentionMessage: null,
    attentionAt: null,
    attentionClearedAt: new Date(),
  };
}

function buildTrailingStopOrderStatusAttentionData(
  orderStatus: string
): Prisma.PositionExitStateUncheckedUpdateInput {
  switch (orderStatus) {
    case 'rejected':
      return buildAttentionRequiredData({
        code: 'trail_order_rejected',
        message: 'Protective trailing stop order was rejected by the broker.',
      });

    case 'canceled':
      return buildAttentionRequiredData({
        code: 'trail_order_canceled',
        message: 'Protective trailing stop order was canceled.',
      });

    case 'expired':
      return buildAttentionRequiredData({
        code: 'trail_order_expired',
        message: 'Protective trailing stop order expired.',
      });

    default:
      return buildAttentionClearedData();
  }
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
      attentionRequired: false,
      attentionCode: null,
      attentionMessage: null,
      attentionAt: null,
      attentionClearedAt: null,
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
      attentionRequired: false,
      attentionCode: null,
      attentionMessage: null,
      attentionAt: null,
      attentionClearedAt: null,
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
      attentionRequired: false,
      attentionCode: null,
      attentionMessage: null,
      attentionAt: null,
      attentionClearedAt: null,
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
      status: mapTrailingStopOrderStatusToExitStateStatus(args.orderStatus),
      trailBroker: args.broker,
      trailBrokerOrderId: args.brokerOrderId,
      trailClientOrderId: args.clientOrderId,
      trailOrderStatus: args.orderStatus,
      rawBrokerJson: args.rawBrokerJson,
      ...buildTrailingStopOrderStatusAttentionData(args.orderStatus),
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
      ...buildAttentionRequiredData({
        code: 'trail_submit_failed',
        message: 'Protective trailing stop order submission failed.',
      }),
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
    attentionRequired: false,
    attentionCode: null,
    attentionMessage: null,
    attentionAt: null,
    attentionClearedAt: new Date(),
    ...(payloadJson !== undefined ? { rawBrokerJson: payloadJson } : {}),
  };

  const updateData: Prisma.PositionExitStateUncheckedUpdateInput = {
    status: 'closed',
    ...buildAttentionClearedData(),
    ...(payloadJson !== undefined ? { rawBrokerJson: payloadJson } : {}),
  };

  return prisma.positionExitState.upsert({
    where: { trackedPositionId },
    create: createData,
    update: updateData,
  });
}

export async function syncTrailingStopOrderStatus(
  args: SyncTrailingStopOrderStatusArgs
) {
  const updateData: Prisma.PositionExitStateUpdateManyMutationInput = {
    status: mapTrailingStopOrderStatusToExitStateStatus(args.orderStatus),
    trailOrderStatus: args.orderStatus,
    rawBrokerJson: args.rawBrokerJson,
    ...(args.brokerOrderId !== undefined
      ? { trailBrokerOrderId: args.brokerOrderId }
      : {}),
    ...buildTrailingStopOrderStatusAttentionData(args.orderStatus),
  };

  return prisma.positionExitState.updateMany({
    where: {
      trailClientOrderId: args.clientOrderId,
    },
    data: updateData,
  });
}