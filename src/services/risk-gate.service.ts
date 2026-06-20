import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getNormalizedAccount } from './account.service.js';
import { getRuntimeTradingConfig } from './config.service.js';
import { createSystemEvent } from './system-event.service.js';
import type { ResolvedPlaceOrderInput } from '../validators/place-order.schema.js';
import {
  entrySessionDetailsAsJson,
  evaluateEntrySessionGuard,
  isEntrySessionBlocked,
  type EntrySessionDecision,
} from './entry-session-guard.service.js';

type RiskGateAllowed = {
  allowed: true;
  details: Prisma.InputJsonValue;
};

export type RiskGateBlocked = {
  allowed: false;
  statusCode: number;
  reason: string;
  details: Prisma.InputJsonValue;
};

export type RiskGateResult = RiskGateAllowed | RiskGateBlocked;

const ACTIVE_POSITION_STATUSES = ['open', 'closing'];
const ENTRY_ORDER_STATUSES = ['pending', 'submitted', 'filled'];

function isEntryOrder(input: ResolvedPlaceOrderInput): boolean {
  return input.side === 'buy' && (input.signalType ?? 'entry') === 'entry';
}

function startOfUtcDay(date = new Date()) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function isLimitEnabled(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function getRequestedNotional(input: ResolvedPlaceOrderInput): number | null {
  if (input.notional !== undefined) {
    return input.notional;
  }

  if (input.qty !== undefined && input.limitPrice !== undefined) {
    return input.qty * input.limitPrice;
  }

  return null;
}

function getPositionExposure(position: {
  marketValue: number;
  costBasis: number;
}) {
  const exposure = position.marketValue || position.costBasis || 0;
  return Math.abs(exposure);
}

function block(
  statusCode: number,
  reason: string,
  details: Record<string, unknown> = {}
): RiskGateBlocked {
  return {
    allowed: false,
    statusCode,
    reason,
    details: details as Prisma.InputJsonValue,
  };
}

function sessionBlockReason(rule: string) {
  switch (rule) {
    case 'entry_open_buffer_active':
      return 'Opening entry buffer is active.';
    case 'entry_close_buffer_active':
      return 'Pre-close entry cutoff is active.';
    case 'market_clock_unavailable':
      return 'Alpaca market session is unavailable.';
    case 'entry_window_unavailable':
      return 'Entry window is unavailable.';
    case 'market_closed':
    default:
      return 'Regular market is closed.';
  }
}

async function findSubscriptionForInput(input: ResolvedPlaceOrderInput) {
  const include = {
    strategy: true,
    exitProfile: true,
    security: true,
  };

  if (input.subscriptionId !== undefined) {
    return prisma.subscription.findUnique({
      where: { id: input.subscriptionId },
      include,
    });
  }

  if (input.subscriptionKey !== undefined) {
    return prisma.subscription.findUnique({
      where: { key: input.subscriptionKey },
      include,
    });
  }

  return null;
}

async function getRiskUsage() {
  const todayStart = startOfUtcDay();

  const [activePositions, dailyEntryOrders] = await Promise.all([
    prisma.trackedPosition.findMany({
      where: {
        status: {
          in: ACTIVE_POSITION_STATUSES,
        },
      },
      select: {
        id: true,
        symbol: true,
        subscriptionId: true,
        marketValue: true,
        costBasis: true,
        status: true,
      },
    }),

    prisma.orderIntent.findMany({
      where: {
        side: 'buy',
        status: {
          in: ENTRY_ORDER_STATUSES,
        },
        createdAt: {
          gte: todayStart,
        },
      },
      select: {
        id: true,
        symbol: true,
        subscriptionId: true,
        notional: true,
        qty: true,
        limitPrice: true,
        status: true,
      },
    }),
  ]);

  const totalOpenNotional = activePositions.reduce(
    (total, position) => total + getPositionExposure(position),
    0
  );

  const dailyEntryNotional = dailyEntryOrders.reduce((total, order) => {
    if (order.notional !== null) {
      return total + order.notional;
    }

    if (order.qty !== null && order.limitPrice !== null) {
      return total + order.qty * order.limitPrice;
    }

    return total;
  }, 0);

  return {
    activePositions,
    dailyEntryOrders,
    dailyEntryOrderCount: dailyEntryOrders.length,
    dailyEntryNotional,
    totalOpenNotional,
    activePositionCount: activePositions.length,
    activeSymbols: Array.from(
      new Set(activePositions.map((position) => position.symbol))
    ),
  };
}

export async function evaluateOrderRisk(
  input: ResolvedPlaceOrderInput
): Promise<RiskGateResult> {
  const config = await getRuntimeTradingConfig();

  if (!config.tradingEnabled) {
    return block(403, 'Trading is disabled.', {
      rule: 'tradingEnabled',
      tradingEnabled: config.tradingEnabled,
    });
  }

  const subscription = await findSubscriptionForInput(input);

  const security =
    subscription?.security ??
    (await prisma.security.findUnique({
      where: { symbol: input.symbol },
    }));

  if (!security) {
    return block(403, `Ticker ${input.symbol} is not in the securities database.`, {
      rule: 'security_registered',
      symbol: input.symbol,
    });
  }

  if (!security.enabled) {
    return block(409, `Security ${input.symbol} is disabled for trading.`, {
      rule: 'security_enabled',
      symbol: input.symbol,
    });
  }

  if (input.subscriptionKey !== undefined || input.subscriptionId !== undefined) {
    if (!subscription) {
      return block(404, `Subscription ${input.subscriptionKey ?? input.subscriptionId} was not found.`, {
        rule: 'subscription_exists',
        subscriptionKey: input.subscriptionKey ?? null,
        subscriptionId: input.subscriptionId ?? null,
      });
    }

    if (!subscription.enabled) {
      return block(403, `Subscription ${subscription.key} is disabled.`, {
        rule: 'subscription_enabled',
        subscriptionKey: subscription.key,
      });
    }

    if (!subscription.strategy.enabled) {
      return block(403, `Strategy ${subscription.strategy.key} is disabled.`, {
        rule: 'strategy_enabled',
        strategyKey: subscription.strategy.key,
      });
    }

    if (!subscription.exitProfile.enabled) {
      return block(403, `Exit profile ${subscription.exitProfile.key} is disabled.`, {
        rule: 'exit_profile_enabled',
        exitProfileKey: subscription.exitProfile.key,
      });
    }
  }

  const entryOrder = isEntryOrder(input);

  if (entryOrder && config.killSwitchEnabled) {
    return block(403, 'Kill switch is active. New entries are blocked.', {
      rule: 'killSwitchEnabled',
      killSwitchEnabled: config.killSwitchEnabled,
      symbol: input.symbol,
      subscriptionKey: input.subscriptionKey ?? null,
    });
  }

  const account = await getNormalizedAccount('risk_gate_account_check');

  if (account.tradingBlocked) {
    return block(403, 'Broker account is trading blocked.', {
      rule: 'broker_trading_blocked',
      broker: account.broker,
      mode: account.mode,
      tradingBlocked: account.tradingBlocked,
    });
  }

  const expectedMode = config.paperMode ? 'paper' : 'live';

  if (account.mode !== expectedMode) {
    return block(
      409,
      `Broker mode mismatch. Runtime config expects ${expectedMode}, but Alpaca account is ${account.mode}.`,
      {
        rule: 'broker_mode_match',
        expectedMode,
        actualMode: account.mode,
        paperMode: config.paperMode,
      }
    );
  }

  if (!entryOrder) {
    return {
      allowed: true,
      details: {
        orderType: 'non_entry',
        symbol: input.symbol,
        side: input.side,
        reason: 'Entry-only risk limits were skipped.',
      } as Prisma.InputJsonValue,
    };
  }

  const entrySession = await evaluateEntrySessionGuard(config);

  if (isEntrySessionBlocked(entrySession)) {
    return {
      allowed: false,
      statusCode: entrySession.statusCode,
      reason: entrySession.reason,
      details: entrySessionDetailsAsJson(entrySession),
    };
  }

  const requestedNotional = getRequestedNotional(input);
  const usage = await getRiskUsage();

  const existingSymbolPosition = usage.activePositions.find(
    (position) => position.symbol === input.symbol
  );

  if (existingSymbolPosition) {
    return block(
      409,
      `Entry signal blocked because ${input.symbol} already has an open or closing tracked position.`,
      {
        rule: 'one_active_position_per_symbol',
        symbol: input.symbol,
        trackedPositionId: existingSymbolPosition.id,
        trackedPositionStatus: existingSymbolPosition.status,
      }
    );
  }

  if (
    isLimitEnabled(config.maxDailyEntryOrders) &&
    usage.dailyEntryOrderCount >= config.maxDailyEntryOrders
  ) {
    return block(409, 'Daily entry order limit reached.', {
      rule: 'maxDailyEntryOrders',
      maxDailyEntryOrders: config.maxDailyEntryOrders,
      dailyEntryOrderCount: usage.dailyEntryOrderCount,
    });
  }

  if (
    isLimitEnabled(config.maxOpenPositions) &&
    usage.activePositionCount >= config.maxOpenPositions
  ) {
    return block(409, 'Maximum open position limit reached.', {
      rule: 'maxOpenPositions',
      maxOpenPositions: config.maxOpenPositions,
      activePositionCount: usage.activePositionCount,
      activeSymbols: usage.activeSymbols,
    });
  }

  if (
    requestedNotional !== null &&
    isLimitEnabled(config.maxDailyEntryNotional) &&
    usage.dailyEntryNotional + requestedNotional > config.maxDailyEntryNotional
  ) {
    return block(409, 'Daily entry notional limit would be exceeded.', {
      rule: 'maxDailyEntryNotional',
      maxDailyEntryNotional: config.maxDailyEntryNotional,
      dailyEntryNotional: usage.dailyEntryNotional,
      requestedNotional,
      projectedDailyEntryNotional: usage.dailyEntryNotional + requestedNotional,
    });
  }

  if (
    requestedNotional !== null &&
    isLimitEnabled(config.maxTotalOpenNotional) &&
    usage.totalOpenNotional + requestedNotional > config.maxTotalOpenNotional
  ) {
    return block(409, 'Total open notional limit would be exceeded.', {
      rule: 'maxTotalOpenNotional',
      maxTotalOpenNotional: config.maxTotalOpenNotional,
      totalOpenNotional: usage.totalOpenNotional,
      requestedNotional,
      projectedTotalOpenNotional: usage.totalOpenNotional + requestedNotional,
    });
  }

  if (
    requestedNotional !== null &&
    isLimitEnabled(config.maxSymbolOpenNotional) &&
    requestedNotional > config.maxSymbolOpenNotional
  ) {
    return block(409, `Symbol exposure limit would be exceeded for ${input.symbol}.`, {
      rule: 'maxSymbolOpenNotional',
      symbol: input.symbol,
      maxSymbolOpenNotional: config.maxSymbolOpenNotional,
      requestedNotional,
    });
  }

  if (
    requestedNotional !== null &&
    input.subscriptionId !== undefined &&
    isLimitEnabled(config.maxSubscriptionOpenNotional) &&
    requestedNotional > config.maxSubscriptionOpenNotional
  ) {
    return block(
      409,
      `Subscription exposure limit would be exceeded for ${input.subscriptionKey ?? input.subscriptionId}.`,
      {
        rule: 'maxSubscriptionOpenNotional',
        subscriptionId: input.subscriptionId,
        subscriptionKey: input.subscriptionKey ?? null,
        maxSubscriptionOpenNotional: config.maxSubscriptionOpenNotional,
        requestedNotional,
      }
    );
  }

  return {
    allowed: true,
    details: {
      orderType: 'entry',
      symbol: input.symbol,
      side: input.side,
      subscriptionKey: input.subscriptionKey ?? null,
      requestedNotional,
      entrySession: entrySession.details,
      usage: {
        dailyEntryOrderCount: usage.dailyEntryOrderCount,
        dailyEntryNotional: usage.dailyEntryNotional,
        activePositionCount: usage.activePositionCount,
        totalOpenNotional: usage.totalOpenNotional,
        activeSymbols: usage.activeSymbols,
      },
    } as Prisma.InputJsonValue,
  };
}

export async function logRiskGateBlockedOrder(args: {
  orderIntentId: number;
  input: ResolvedPlaceOrderInput;
  result: RiskGateBlocked;
}) {
  await createSystemEvent({
    type: 'risk_gate.blocked',
    entityType: 'orderIntent',
    entityId: args.orderIntentId,
    payloadJson: {
      orderIntentId: args.orderIntentId,
      symbol: args.input.symbol,
      side: args.input.side,
      subscriptionKey: args.input.subscriptionKey ?? null,
      reason: args.result.reason,
      statusCode: args.result.statusCode,
      details: args.result.details,
    } as Prisma.InputJsonValue,
  });
}

export async function getRiskStatus() {
  const config = await getRuntimeTradingConfig();
  const account = await getNormalizedAccount('risk_gate_account_check');
  const usage = await getRiskUsage();

  const expectedMode = config.paperMode ? 'paper' : 'live';
  const reasons: string[] = [];

  if (!config.tradingEnabled) {
    reasons.push('Trading is disabled.');
  }

  if (config.killSwitchEnabled) {
    reasons.push('Kill switch is active. New entries are blocked.');
  }

  if (account.tradingBlocked) {
    reasons.push('Broker account is trading blocked.');
  }

  if (account.mode !== expectedMode) {
    reasons.push(
      `Broker mode mismatch. Runtime config expects ${expectedMode}, but Alpaca account is ${account.mode}.`
    );
  }

  const entrySession: EntrySessionDecision =
    await evaluateEntrySessionGuard(config);

  if (isEntrySessionBlocked(entrySession)) {
    reasons.push(sessionBlockReason(entrySession.details.rule));
  }

  if (
    isLimitEnabled(config.maxDailyEntryOrders) &&
    usage.dailyEntryOrderCount >= config.maxDailyEntryOrders
  ) {
    reasons.push('Daily entry order limit reached.');
  }

  if (
    isLimitEnabled(config.maxOpenPositions) &&
    usage.activePositionCount >= config.maxOpenPositions
  ) {
    reasons.push('Maximum open position limit reached.');
  }

  if (
    isLimitEnabled(config.maxDailyEntryNotional) &&
    usage.dailyEntryNotional >= config.maxDailyEntryNotional
  ) {
    reasons.push('Daily entry notional limit reached.');
  }

  if (
    isLimitEnabled(config.maxTotalOpenNotional) &&
    usage.totalOpenNotional >= config.maxTotalOpenNotional
  ) {
    reasons.push('Total open notional limit reached.');
  }

  return {
    canEnter: reasons.length === 0,
    reasons,
    broker: {
      name: account.broker,
      mode: account.mode,
      expectedMode,
      tradingBlocked: account.tradingBlocked,
    },
    limits: {
      maxDailyEntryOrders: config.maxDailyEntryOrders,
      maxDailyEntryNotional: config.maxDailyEntryNotional,
      maxOpenPositions: config.maxOpenPositions,
      maxTotalOpenNotional: config.maxTotalOpenNotional,
      maxSymbolOpenNotional: config.maxSymbolOpenNotional,
      maxSubscriptionOpenNotional: config.maxSubscriptionOpenNotional,
    },
    entrySession: {
      enabled: config.entrySessionGuardEnabled,
      status: entrySession.details.status,
      canEnterNow: entrySession.allowed,
      marketOpen: entrySession.details.marketOpen,
      evaluatedAt: entrySession.details.evaluatedAt,
      sessionOpenAt: entrySession.details.sessionOpenAt,
      entryAllowedAt: entrySession.details.entryAllowedAt,
      entryCutoffAt: entrySession.details.entryCutoffAt,
      sessionCloseAt: entrySession.details.sessionCloseAt,
      nextOpenAt: entrySession.details.nextOpenAt,
      openingBufferMinutes: entrySession.details.openingBufferMinutes,
      closingBufferMinutes: entrySession.details.closingBufferMinutes,
      failClosed: entrySession.details.failClosed,
      degraded: entrySession.allowed ? entrySession.degraded : false,
      rule: isEntrySessionBlocked(entrySession)
        ? entrySession.details.rule
        : null,
      error: entrySession.details.error ?? null,
    },
    usage: {
      dailyEntryOrderCount: usage.dailyEntryOrderCount,
      dailyEntryNotional: usage.dailyEntryNotional,
      activePositionCount: usage.activePositionCount,
      totalOpenNotional: usage.totalOpenNotional,
      activeSymbols: usage.activeSymbols,
    },
  };
}
