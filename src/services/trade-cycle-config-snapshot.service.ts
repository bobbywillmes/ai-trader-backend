import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getRuntimeTradingConfig } from './config.service.js';

type BuildSnapshotArgs = {
  broker: string;
  symbol: string;
  securityId: number;
  subscriptionId: number | null;
  source: 'position_opened' | 'subscription_recovered';
};

function toIso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

export async function buildTradeCycleConfigSnapshot(
  args: BuildSnapshotArgs
): Promise<Prisma.InputJsonValue> {
  const [security, subscription, runtimeConfig] = await Promise.all([
    prisma.security.findUnique({
      where: { id: args.securityId },
    }),
    args.subscriptionId === null
      ? Promise.resolve(null)
      : prisma.subscription.findUnique({
          where: { id: args.subscriptionId },
          include: {
            strategy: true,
            exitProfile: true,
            security: true,
          },
        }),
    getRuntimeTradingConfig(),
  ]);

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    source: args.source,
    broker: args.broker,
    symbol: args.symbol,
    security: security
      ? {
          id: security.id,
          symbol: security.symbol,
          name: security.name,
          assetType: security.assetType,
          sector: security.sector,
          industry: security.industry,
          enabled: security.enabled,
        }
      : null,
    subscription: subscription
      ? {
          id: subscription.id,
          key: subscription.key,
          name: subscription.name,
          symbol: subscription.symbol,
          broker: subscription.broker,
          brokerMode: subscription.brokerMode,
          sizingType: subscription.sizingType,
          sizingValue: subscription.sizingValue,
          enabled: subscription.enabled,
          createdAt: toIso(subscription.createdAt),
          updatedAt: toIso(subscription.updatedAt),
        }
      : null,
    strategy: subscription?.strategy
      ? {
          id: subscription.strategy.id,
          key: subscription.strategy.key,
          name: subscription.strategy.name,
          description: subscription.strategy.description,
          allowedSymbolsJson: subscription.strategy.allowedSymbolsJson,
          enabled: subscription.strategy.enabled,
          createdAt: toIso(subscription.strategy.createdAt),
          updatedAt: toIso(subscription.strategy.updatedAt),
        }
      : null,
    exitProfile: subscription?.exitProfile
      ? {
          id: subscription.exitProfile.id,
          key: subscription.exitProfile.key,
          name: subscription.exitProfile.name,
          description: subscription.exitProfile.description,
          targetPct: subscription.exitProfile.targetPct,
          stopLossPct: subscription.exitProfile.stopLossPct,
          trailingStopPct: subscription.exitProfile.trailingStopPct,
          maxHoldDays: subscription.exitProfile.maxHoldDays,
          exitMode: subscription.exitProfile.exitMode,
          takeProfitBehavior: subscription.exitProfile.takeProfitBehavior,
          enabled: subscription.exitProfile.enabled,
          createdAt: toIso(subscription.exitProfile.createdAt),
          updatedAt: toIso(subscription.exitProfile.updatedAt),
        }
      : null,
    runtimeRisk: {
      tradingEnabled: runtimeConfig.tradingEnabled,
      paperMode: runtimeConfig.paperMode,
      killSwitchEnabled: runtimeConfig.killSwitchEnabled,
      maxDailyEntryOrders: runtimeConfig.maxDailyEntryOrders,
      maxDailyEntryNotional: runtimeConfig.maxDailyEntryNotional,
      maxOpenPositions: runtimeConfig.maxOpenPositions,
      maxTotalOpenNotional: runtimeConfig.maxTotalOpenNotional,
      maxSymbolOpenNotional: runtimeConfig.maxSymbolOpenNotional,
      maxSubscriptionOpenNotional: runtimeConfig.maxSubscriptionOpenNotional,
    },
  } as Prisma.InputJsonValue;
}

export async function captureTrackedPositionConfigSnapshot(args: {
  trackedPositionId: number;
  source: 'position_opened' | 'subscription_recovered';
}) {
  const position = await prisma.trackedPosition.findUnique({
    where: { id: args.trackedPositionId },
    select: {
      id: true,
      broker: true,
      symbol: true,
      securityId: true,
      subscriptionId: true,
      configSnapshotJson: true,
    },
  });

  if (!position || position.configSnapshotJson !== null) {
    return position;
  }

  const snapshot = await buildTradeCycleConfigSnapshot({
    broker: position.broker,
    symbol: position.symbol,
    securityId: position.securityId,
    subscriptionId: position.subscriptionId,
    source: args.source,
  });

  return prisma.trackedPosition.update({
    where: { id: position.id },
    data: {
      configSnapshotJson: snapshot,
      configSnapshotCapturedAt: new Date(),
    },
  });
}
