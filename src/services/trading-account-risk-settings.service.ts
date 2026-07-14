import { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import type { UpdateTradingAccountRiskSettingsInput } from '../validators/trading-account.schema.js';
import { getRuntimeTradingConfig } from './config.service.js';
import {
  resolveEffectiveAccountEntryLimits,
  type EffectiveAccountEntryLimits,
} from './trading-account-entry-risk-limits.service.js';

const TRADING_ACCOUNT_RISK_SETTINGS_SELECT = {
  id: true,
  tradingAccountId: true,
  enabled: true,
  maxDailyEntryOrders: true,
  maxDailyEntryNotional: true,
  maxOpenPositions: true,
  maxTotalOpenNotional: true,
  maxSymbolOpenNotional: true,
  maxSubscriptionOpenNotional: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TradingAccountRiskSettingsSelect;

type TradingAccountRiskSettingsRecord =
  Prisma.TradingAccountRiskSettingsGetPayload<{
    select: typeof TRADING_ACCOUNT_RISK_SETTINGS_SELECT;
  }>;

export type TradingAccountRiskSettingsResponse = ReturnType<
  typeof serializeTradingAccountRiskSettings
> & { effectiveEntryLimits: EffectiveAccountEntryLimits };

async function getTradingAccountContext(tradingAccountId: number) {
  return prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { id: true, maxDeployableNotional: true },
  });
}

export function serializeTradingAccountRiskSettings(
  settings: TradingAccountRiskSettingsRecord
) {
  return {
    id: settings.id,
    tradingAccountId: settings.tradingAccountId,
    enabled: settings.enabled,
    maxDailyEntryOrders: settings.maxDailyEntryOrders,
    maxDailyEntryNotional: settings.maxDailyEntryNotional,
    maxOpenPositions: settings.maxOpenPositions,
    maxTotalOpenNotional: settings.maxTotalOpenNotional,
    maxSymbolOpenNotional: settings.maxSymbolOpenNotional,
    maxSubscriptionOpenNotional: settings.maxSubscriptionOpenNotional,
    notes: settings.notes,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt,
  };
}

export async function getTradingAccountRiskSettingsForAdmin(
  tradingAccountId: number
) {
  const account = await getTradingAccountContext(tradingAccountId);

  if (!account) {
    return null;
  }

  const settings = await prisma.tradingAccountRiskSettings.upsert({
    where: { tradingAccountId },
    update: {},
    create: {
      tradingAccountId,
    },
    select: TRADING_ACCOUNT_RISK_SETTINGS_SELECT,
  });

  const globalConfig = await getRuntimeTradingConfig();

  return {
    ...serializeTradingAccountRiskSettings(settings),
    effectiveEntryLimits: resolveEffectiveAccountEntryLimits({
      tradingAccountId,
      maxDeployableNotional: account.maxDeployableNotional,
      accountRiskSettings: settings,
      globalConfig,
    }),
  };
}

export async function updateTradingAccountRiskSettingsForAdmin(
  tradingAccountId: number,
  input: UpdateTradingAccountRiskSettingsInput
) {
  const account = await getTradingAccountContext(tradingAccountId);

  if (!account) {
    return null;
  }

  const settings = await prisma.tradingAccountRiskSettings.upsert({
    where: { tradingAccountId },
    update: {
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.maxDailyEntryOrders !== undefined && {
        maxDailyEntryOrders: input.maxDailyEntryOrders,
      }),
      ...(input.maxDailyEntryNotional !== undefined && {
        maxDailyEntryNotional: input.maxDailyEntryNotional,
      }),
      ...(input.maxOpenPositions !== undefined && {
        maxOpenPositions: input.maxOpenPositions,
      }),
      ...(input.maxTotalOpenNotional !== undefined && {
        maxTotalOpenNotional: input.maxTotalOpenNotional,
      }),
      ...(input.maxSymbolOpenNotional !== undefined && {
        maxSymbolOpenNotional: input.maxSymbolOpenNotional,
      }),
      ...(input.maxSubscriptionOpenNotional !== undefined && {
        maxSubscriptionOpenNotional: input.maxSubscriptionOpenNotional,
      }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
    create: {
      tradingAccountId,
      enabled: input.enabled ?? true,
      ...(input.maxDailyEntryOrders !== undefined && {
        maxDailyEntryOrders: input.maxDailyEntryOrders,
      }),
      ...(input.maxDailyEntryNotional !== undefined && {
        maxDailyEntryNotional: input.maxDailyEntryNotional,
      }),
      ...(input.maxOpenPositions !== undefined && {
        maxOpenPositions: input.maxOpenPositions,
      }),
      ...(input.maxTotalOpenNotional !== undefined && {
        maxTotalOpenNotional: input.maxTotalOpenNotional,
      }),
      ...(input.maxSymbolOpenNotional !== undefined && {
        maxSymbolOpenNotional: input.maxSymbolOpenNotional,
      }),
      ...(input.maxSubscriptionOpenNotional !== undefined && {
        maxSubscriptionOpenNotional: input.maxSubscriptionOpenNotional,
      }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
    select: TRADING_ACCOUNT_RISK_SETTINGS_SELECT,
  });

  const globalConfig = await getRuntimeTradingConfig();

  return {
    ...serializeTradingAccountRiskSettings(settings),
    effectiveEntryLimits: resolveEffectiveAccountEntryLimits({
      tradingAccountId,
      maxDeployableNotional: account.maxDeployableNotional,
      accountRiskSettings: settings,
      globalConfig,
    }),
  };
}
