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
import { resolveDefaultTradingAccountId } from './trading-account.service.js';

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

type EvaluateOrderRiskOptions = {
  requestedNotionalOverride?: number | null;
};

type AccountRiskSettings = {
  enabled: boolean;
  maxDailyEntryOrders: number | null;
  maxDailyEntryNotional: number | null;
  maxOpenPositions: number | null;
  maxTotalOpenNotional: number | null;
  maxSymbolOpenNotional: number | null;
  maxSubscriptionOpenNotional: number | null;
};

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

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function getRequestedNotional(
  input: ResolvedPlaceOrderInput,
  options: EvaluateOrderRiskOptions = {}
): number | null {
  if (isPositiveFiniteNumber(options.requestedNotionalOverride)) {
    return options.requestedNotionalOverride;
  }

  if (input.notional !== undefined) {
    return input.notional;
  }

  if (input.qty !== undefined && input.limitPrice !== undefined) {
    return input.qty * input.limitPrice;
  }

  return null;
}

function getAccountSubscriptionSizingEstimatedNotional(
  value: Prisma.JsonValue
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const sizing = raw.accountSubscriptionSizing;

  if (!sizing || typeof sizing !== 'object' || Array.isArray(sizing)) {
    return null;
  }

  const estimatedNotional = (
    sizing as Record<string, unknown>
  ).estimatedNotional;

  return isPositiveFiniteNumber(estimatedNotional)
    ? estimatedNotional
    : null;
}

function getOrderIntentEstimatedNotional(order: {
  notional: number | null;
  qty: number | null;
  limitPrice: number | null;
  rawRequestJson: Prisma.JsonValue;
}) {
  if (order.notional !== null) {
    return order.notional;
  }

  if (order.qty !== null && order.limitPrice !== null) {
    return order.qty * order.limitPrice;
  }

  return getAccountSubscriptionSizingEstimatedNotional(order.rawRequestJson);
}

function getPositionExposure(position: {
  marketValue: number;
  costBasis: number;
}) {
  const exposure = position.marketValue || position.costBasis || 0;
  return Math.abs(exposure);
}

function getSymbolOpenNotional(
  positions: Array<{ symbol: string; marketValue: number; costBasis: number }>,
  symbol: string
) {
  return positions
    .filter((position) => position.symbol === symbol)
    .reduce((total, position) => total + getPositionExposure(position), 0);
}

function getSubscriptionOpenNotional(
  positions: Array<{
    subscriptionId: number | null;
    marketValue: number;
    costBasis: number;
  }>,
  subscriptionId: number
) {
  return positions
    .filter((position) => position.subscriptionId === subscriptionId)
    .reduce((total, position) => total + getPositionExposure(position), 0);
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

async function findSubscriptionForInput(
  input: ResolvedPlaceOrderInput,
  tradingAccountId: number
) {
  const include = {
    strategy: true,
    exitProfile: true,
    security: true,
  };

  if (input.subscriptionId !== undefined) {
    return prisma.subscription.findFirst({
      where: {
        id: input.subscriptionId,
        tradingAccountId,
      },
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

async function getRiskUsage(tradingAccountId: number) {
  const todayStart = startOfUtcDay();

  const [activePositions, dailyEntryOrders] = await Promise.all([
    prisma.trackedPosition.findMany({
      where: {
        tradingAccountId,
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
        tradingAccountId,
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
        rawRequestJson: true,
        status: true,
      },
    }),
  ]);

  const totalOpenNotional = activePositions.reduce(
    (total, position) => total + getPositionExposure(position),
    0
  );

  const dailyEntryNotional = dailyEntryOrders.reduce((total, order) => {
    return total + (getOrderIntentEstimatedNotional(order) ?? 0);
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

async function getAccountRiskSettings(
  tradingAccountId: number
): Promise<AccountRiskSettings | null> {
  return prisma.tradingAccountRiskSettings.findUnique({
    where: {
      tradingAccountId,
    },
    select: {
      enabled: true,
      maxDailyEntryOrders: true,
      maxDailyEntryNotional: true,
      maxOpenPositions: true,
      maxTotalOpenNotional: true,
      maxSymbolOpenNotional: true,
      maxSubscriptionOpenNotional: true,
    },
  });
}

export async function evaluateOrderRisk(
  input: ResolvedPlaceOrderInput,
  options: EvaluateOrderRiskOptions = {}
): Promise<RiskGateResult> {
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const config = await getRuntimeTradingConfig();

  if (!config.tradingEnabled) {
    return block(403, 'Trading is disabled.', {
      rule: 'tradingEnabled',
      tradingEnabled: config.tradingEnabled,
    });
  }

  const subscription = await findSubscriptionForInput(input, tradingAccountId);

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

  const account = await getNormalizedAccount('risk_gate_account_check', {
    tradingAccountId,
  });

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

  const entrySession = await evaluateEntrySessionGuard(config, new Date(), {
    tradingAccountId,
  });

  if (isEntrySessionBlocked(entrySession)) {
    return {
      allowed: false,
      statusCode: entrySession.statusCode,
      reason: entrySession.reason,
      details: entrySessionDetailsAsJson(entrySession),
    };
  }

  const requestedNotional = getRequestedNotional(input, options);
  const usage = await getRiskUsage(tradingAccountId);

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

  const accountRiskSettings = await getAccountRiskSettings(tradingAccountId);

  if (accountRiskSettings?.enabled) {
    if (
      isLimitEnabled(accountRiskSettings.maxDailyEntryOrders) &&
      usage.dailyEntryOrderCount >= accountRiskSettings.maxDailyEntryOrders
    ) {
      return block(409, 'Account daily entry order limit reached.', {
        rule: 'account_max_daily_entry_orders_exceeded',
        tradingAccountId,
        maxDailyEntryOrders: accountRiskSettings.maxDailyEntryOrders,
        dailyEntryOrderCount: usage.dailyEntryOrderCount,
      });
    }

    if (
      isLimitEnabled(accountRiskSettings.maxOpenPositions) &&
      usage.activePositionCount >= accountRiskSettings.maxOpenPositions
    ) {
      return block(409, 'Account maximum open position limit reached.', {
        rule: 'account_max_open_positions_exceeded',
        tradingAccountId,
        maxOpenPositions: accountRiskSettings.maxOpenPositions,
        activePositionCount: usage.activePositionCount,
        activeSymbols: usage.activeSymbols,
      });
    }

    if (
      requestedNotional !== null &&
      isLimitEnabled(accountRiskSettings.maxDailyEntryNotional) &&
      usage.dailyEntryNotional + requestedNotional >
        accountRiskSettings.maxDailyEntryNotional
    ) {
      return block(409, 'Account daily entry notional limit would be exceeded.', {
        rule: 'account_max_daily_entry_notional_exceeded',
        tradingAccountId,
        maxDailyEntryNotional: accountRiskSettings.maxDailyEntryNotional,
        dailyEntryNotional: usage.dailyEntryNotional,
        requestedNotional,
        projectedDailyEntryNotional:
          usage.dailyEntryNotional + requestedNotional,
      });
    }

    if (
      requestedNotional !== null &&
      isLimitEnabled(accountRiskSettings.maxTotalOpenNotional) &&
      usage.totalOpenNotional + requestedNotional >
        accountRiskSettings.maxTotalOpenNotional
    ) {
      return block(409, 'Account total open notional limit would be exceeded.', {
        rule: 'account_max_total_open_notional_exceeded',
        tradingAccountId,
        maxTotalOpenNotional: accountRiskSettings.maxTotalOpenNotional,
        totalOpenNotional: usage.totalOpenNotional,
        requestedNotional,
        projectedTotalOpenNotional:
          usage.totalOpenNotional + requestedNotional,
      });
    }

    const symbolOpenNotional = getSymbolOpenNotional(
      usage.activePositions,
      input.symbol
    );

    if (
      requestedNotional !== null &&
      isLimitEnabled(accountRiskSettings.maxSymbolOpenNotional) &&
      symbolOpenNotional + requestedNotional >
        accountRiskSettings.maxSymbolOpenNotional
    ) {
      return block(
        409,
        `Account symbol exposure limit would be exceeded for ${input.symbol}.`,
        {
          rule: 'account_max_symbol_open_notional_exceeded',
          tradingAccountId,
          symbol: input.symbol,
          maxSymbolOpenNotional: accountRiskSettings.maxSymbolOpenNotional,
          symbolOpenNotional,
          requestedNotional,
          projectedSymbolOpenNotional:
            symbolOpenNotional + requestedNotional,
        }
      );
    }

    if (
      requestedNotional !== null &&
      input.subscriptionId !== undefined &&
      isLimitEnabled(accountRiskSettings.maxSubscriptionOpenNotional)
    ) {
      const subscriptionOpenNotional = getSubscriptionOpenNotional(
        usage.activePositions,
        input.subscriptionId
      );

      if (
        subscriptionOpenNotional + requestedNotional >
        accountRiskSettings.maxSubscriptionOpenNotional
      ) {
        return block(
          409,
          `Account subscription exposure limit would be exceeded for ${input.subscriptionKey ?? input.subscriptionId}.`,
          {
            rule: 'account_max_subscription_open_notional_exceeded',
            tradingAccountId,
            subscriptionId: input.subscriptionId,
            subscriptionKey: input.subscriptionKey ?? null,
            maxSubscriptionOpenNotional:
              accountRiskSettings.maxSubscriptionOpenNotional,
            subscriptionOpenNotional,
            requestedNotional,
            projectedSubscriptionOpenNotional:
              subscriptionOpenNotional + requestedNotional,
          }
        );
      }
    }
  }

  return {
    allowed: true,
    details: {
      orderType: 'entry',
      tradingAccountId,
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
  tradingAccountId?: number | null;
  input: ResolvedPlaceOrderInput;
  result: RiskGateBlocked;
}) {
  await createSystemEvent({
    type: 'risk_gate.blocked',
    entityType: 'orderIntent',
    entityId: args.orderIntentId,
    tradingAccountId: args.tradingAccountId ?? null,
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
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const config = await getRuntimeTradingConfig();
  const account = await getNormalizedAccount('risk_gate_account_check', {
    tradingAccountId,
  });
  const usage = await getRiskUsage(tradingAccountId);

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
    await evaluateEntrySessionGuard(config, new Date(), {
      tradingAccountId,
    });

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
