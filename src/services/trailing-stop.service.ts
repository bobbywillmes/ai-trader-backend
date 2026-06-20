import crypto from 'node:crypto';
import type { ExitProfile, Prisma, TrackedPosition } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import {
  getAlpacaOrderByClientOrderId,
  getAlpacaOrderById,
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
      await getAlpacaOrderByClientOrderId(
        clientOrderId,
        'protective_order_idempotency_check'
      );

    const brokerOrder =
      existingBrokerOrder ??
      (await placeAlpacaOrder(
        {
          symbol: position.symbol,
          side: getExitSide(position),
          type: 'trailing_stop',
          time_in_force: 'gtc',
          qty: String(Math.abs(position.qty)),
          trail_percent: String(exitProfile.trailingStopPct),
          client_order_id: clientOrderId,
        },
        'protective_order_submission'
      ));

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

function isProblemTrailingStopStatus(status: string | null | undefined) {
  return (
    status === 'canceled' ||
    status === 'expired' ||
    status === 'rejected' ||
    status === 'suspended'
  );
}

export async function syncNativeTrailingStopForTrackedPosition(
  trackedPositionId: number
) {
  const position = await prisma.trackedPosition.findUnique({
    where: { id: trackedPositionId },
  });

  if (!position) {
    throw new Error(`TrackedPosition ${trackedPositionId} not found.`);
  }

  // Nothing has been handed off to Alpaca yet, so there is no broker order to sync.
  if (!position.trailingStopOrderId) {
    return {
      ok: false,
      status: 'no_trailing_stop_order',
      trackedPositionId: position.id,
      symbol: position.symbol,
    };
  }

  const brokerOrder = await getAlpacaOrderById(
    position.trailingStopOrderId,
    'protective_order_sync'
  );
  const now = new Date();

  // If Alpaca cannot find the order, do not silently ignore it.
  // This should be rare, but it is important to surface because this order is
  // supposed to be protecting an open position.
  if (!brokerOrder) {
    const previousStatus = position.trailingStopStatus;

    await prisma.trackedPosition.update({
      where: { id: position.id },
      data: {
        trailingStopStatus: 'broker_order_not_found',
        trailingStopLastSyncedAt: now,
        lastSyncedAt: now,
      },
    });

    if (previousStatus !== 'broker_order_not_found') {
      await createSystemEvent({
        type: 'position.trailing_stop_order_not_found',
        entityType: 'trackedPosition',
        entityId: position.id,
        payloadJson: {
          symbol: position.symbol,
          brokerOrderId: position.trailingStopOrderId,
          previousStatus,
        } as Prisma.InputJsonValue,
      });
    }

    return {
      ok: false,
      status: 'broker_order_not_found',
      trackedPositionId: position.id,
      symbol: position.symbol,
      orderId: position.trailingStopOrderId,
    };
  }

  const previousStatus = position.trailingStopStatus;
  const brokerStatus = brokerOrder.status;

  // Copy Alpaca's latest trailing-stop state into TrackedPosition.
  //
  // Important:
  // - Alpaca owns the real trailing stop once submitted.
  // - These local fields are display/sync fields.
  // - We are not recalculating hwm or stop_price ourselves.
  const updated = await prisma.trackedPosition.update({
    where: { id: position.id },
    data: {
      trailingStopStatus: brokerStatus,
      trailingStopTrailPercent:
        toNullableNumber(brokerOrder.trail_percent) ??
        position.trailingStopTrailPercent,
      trailingStopHwm: toNullableNumber(brokerOrder.hwm),
      trailingStopStopPrice: toNullableNumber(brokerOrder.stop_price),
      trailingStopLastSyncedAt: now,
      lastSyncedAt: now,
    },
  });

  // Avoid noisy system events every worker cycle.
  // Only log when the broker order status changes.
  if (previousStatus !== brokerStatus) {
    await createSystemEvent({
      type:
        brokerStatus === 'filled'
          ? 'position.trailing_stop_filled'
          : isProblemTrailingStopStatus(brokerStatus)
            ? 'position.trailing_stop_attention_required'
            : 'position.trailing_stop_status_changed',
      entityType: 'trackedPosition',
      entityId: updated.id,
      payloadJson: {
        symbol: updated.symbol,
        brokerOrderId: updated.trailingStopOrderId,
        previousStatus,
        brokerStatus,
        hwm: updated.trailingStopHwm,
        stopPrice: updated.trailingStopStopPrice,
        trailPercent: updated.trailingStopTrailPercent,
      } as Prisma.InputJsonValue,
    });
  }

  return {
    ok: true,
    status: 'synced',
    trackedPositionId: updated.id,
    symbol: updated.symbol,
    orderId: updated.trailingStopOrderId,
    brokerStatus: updated.trailingStopStatus,
    hwm: updated.trailingStopHwm,
    stopPrice: updated.trailingStopStopPrice,
  };
}
