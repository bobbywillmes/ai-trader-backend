import crypto from 'node:crypto';
import type { ExitProfile, Prisma, TrackedPosition } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import {
  getAlpacaOrderByClientOrderId,
  placeAlpacaOrder,
} from '../integrations/alpaca/orders.adapter.js';
import type { AlpacaOrder } from '../integrations/alpaca/alpaca.types.js';
import { createSystemEvent } from './system-event.service.js';

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildTrailingStopClientOrderId(position: TrackedPosition): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.]/g, '')
    .slice(0, 15);

  return [
    'ai',
    'trail',
    timestamp,
    position.symbol,
    crypto.randomUUID().slice(0, 8),
  ]
    .join('-')
    .slice(0, 128);
}

function getExitSide(position: TrackedPosition): 'buy' | 'sell' {
  return position.side.toLowerCase() === 'short' ? 'buy' : 'sell';
}

function getSubmittedAt(order: AlpacaOrder): Date {
  const submittedAt = new Date(order.submitted_at);

  return Number.isNaN(submittedAt.getTime()) ? new Date() : submittedAt;
}

function getTrailPercentFromOrderOrProfile(
  order: AlpacaOrder,
  exitProfile: ExitProfile
): number | null {
  return (
    toNullableNumber(order.trail_percent) ??
    exitProfile.trailingStopPct ??
    null
  );
}

export async function submitNativeTrailingStopForTrackedPosition(
  trackedPositionId: number,
  unlockPrice?: number
) {
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
    throw new Error(`TrackedPosition ${trackedPositionId} not found.`);
  }

  if (position.status !== 'open') {
    return {
      ok: false,
      status: 'position_not_open',
      trackedPositionId: position.id,
      symbol: position.symbol,
    };
  }

  if (position.trailingStopOrderId) {
    return {
      ok: true,
      status: 'already_submitted',
      trackedPositionId: position.id,
      symbol: position.symbol,
      orderId: position.trailingStopOrderId,
    };
  }

  const exitProfile = position.subscription?.exitProfile;

  if (!exitProfile) {
    throw new Error(
      `TrackedPosition ${position.id} does not have a linked exit profile.`
    );
  }

  if (!exitProfile.trailingStopPct || exitProfile.trailingStopPct <= 0) {
    throw new Error(
      `ExitProfile ${exitProfile.key} does not have a valid trailingStopPct.`
    );
  }

  const now = new Date();
  const clientOrderId =
    position.trailingStopClientOrderId ??
    buildTrailingStopClientOrderId(position);

  if (!position.trailingStopClientOrderId) {
    const claimResult = await prisma.trackedPosition.updateMany({
      where: {
        id: position.id,
        status: 'open',
        trailingStopOrderId: null,
        trailingStopClientOrderId: null,
      },
      data: {
        trailingUnlocked: true,
        trailingUnlockedAt: now,
        trailingUnlockedPrice: unlockPrice ?? position.currentPrice,
        trailingStopClientOrderId: clientOrderId,
        trailingStopStatus: 'pending_submit',
        trailingStopTrailPercent: exitProfile.trailingStopPct,
        trailingStopLastSyncedAt: now,
        lastSyncedAt: now,
      },
    });

    if (claimResult.count !== 1) {
      return {
        ok: false,
        status: 'not_claimed',
        trackedPositionId: position.id,
        symbol: position.symbol,
      };
    }
  }

  try {
    const existingBrokerOrder =
      await getAlpacaOrderByClientOrderId(clientOrderId);

    const brokerOrder =
      existingBrokerOrder ??
      (await placeAlpacaOrder({
        symbol: position.symbol,
        side: getExitSide(position),
        type: 'trailing_stop',
        time_in_force: 'gtc',
        qty: String(Math.abs(position.qty)),
        trail_percent: String(exitProfile.trailingStopPct),
        client_order_id: clientOrderId,
      }));

    const updated = await prisma.trackedPosition.update({
      where: { id: position.id },
      data: {
        trailingUnlocked: true,
        trailingUnlockedAt: position.trailingUnlockedAt ?? now,
        trailingUnlockedPrice: unlockPrice ?? position.currentPrice,
        trailingStopOrderId: brokerOrder.id,
        trailingStopClientOrderId: brokerOrder.client_order_id,
        trailingStopSubmittedAt: getSubmittedAt(brokerOrder),
        trailingStopStatus: brokerOrder.status,
        trailingStopTrailPercent: getTrailPercentFromOrderOrProfile(
          brokerOrder,
          exitProfile
        ),
        trailingStopHwm: toNullableNumber(brokerOrder.hwm),
        trailingStopStopPrice: toNullableNumber(brokerOrder.stop_price),
        trailingStopLastSyncedAt: new Date(),
        lastSyncedAt: new Date(),
      },
    });

    await createSystemEvent({
      type: existingBrokerOrder
        ? 'position.trailing_stop_recovered'
        : 'position.trailing_stop_submitted',
      entityType: 'trackedPosition',
      entityId: updated.id,
      payloadJson: {
        symbol: updated.symbol,
        side: getExitSide(updated),
        qty: updated.qty,
        unlockPrice: updated.trailingUnlockedPrice,
        trailPercent: updated.trailingStopTrailPercent,
        brokerOrderId: updated.trailingStopOrderId,
        clientOrderId: updated.trailingStopClientOrderId,
        brokerStatus: updated.trailingStopStatus,
        hwm: updated.trailingStopHwm,
        stopPrice: updated.trailingStopStopPrice,
      } as Prisma.InputJsonValue,
    });

    return {
      ok: true,
      status: existingBrokerOrder ? 'recovered_existing_order' : 'submitted',
      trackedPositionId: updated.id,
      symbol: updated.symbol,
      orderId: updated.trailingStopOrderId,
      clientOrderId: updated.trailingStopClientOrderId,
      brokerStatus: updated.trailingStopStatus,
    };
  } catch (error) {
    await prisma.trackedPosition.update({
      where: { id: position.id },
      data: {
        trailingStopStatus: 'submit_failed',
        trailingStopLastSyncedAt: new Date(),
        lastSyncedAt: new Date(),
      },
    });

    await createSystemEvent({
      type: 'position.trailing_stop_submit_failed',
      entityType: 'trackedPosition',
      entityId: position.id,
      payloadJson: {
        symbol: position.symbol,
        clientOrderId,
        message: error instanceof Error ? error.message : String(error),
      } as Prisma.InputJsonValue,
    });

    throw error;
  }
}