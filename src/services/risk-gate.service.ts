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
import { resolveEffectiveAccountEntryLimits } from './trading-account-entry-risk-limits.service.js';
import { getTradingAccountEntryRiskUsage } from './trading-account-entry-risk-usage.service.js';

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
const ENTRY_ORDER_STATUSES = [
  'pending',
  'submitting',
  'submitted',
  'new',
  'accepted',
  'accepted_for_bidding',
  'pending_new',
  'partially_filled',
  'filled',
];

type EvaluateOrderRiskOptions = {
  requestedNotionalOverride?: number | null;
  tradingAccountId?: number;
  enforceEntrySessionGuard?: boolean;
  excludeOrderIntentId?: number;
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

const ALLOCATION_RISK_ACCOUNT_SUBSCRIPTION_SELECT = {
  id: true,
  subscriptionId: true,
  allocationId: true,
  enabled: true,
  entriesEnabled: true,
  reservedNotional: true,
  allocation: {
    select: {
      id: true,
      key: true,
      name: true,
      enabled: true,
      maxAllocatedNotional: true,
      maxOpenPositions: true,
      maxPositionNotional: true,
    },
  },
} satisfies Prisma.TradingAccountSubscriptionSelect;

type AllocationRiskAccountSubscription =
  Prisma.TradingAccountSubscriptionGetPayload<{
    select: typeof ALLOCATION_RISK_ACCOUNT_SUBSCRIPTION_SELECT;
  }>;

type AllocationRiskUsage = {
  activePositionCount: number;
  activeSymbols: string[];
  openNotional: number;
  pendingEntryOrderCount: number;
  pendingEntryNotional: number;
  currentAllocatedNotional: number;
  projectedAllocatedNotional: number | null;
};

type AllocationRiskDetails = {
  tradingAccountSubscriptionId: number;
  allocationId: number;
  allocationKey: string;
  allocationName: string;
  enabled: boolean;
  limits: {
    maxAllocatedNotional: number | null;
    maxOpenPositions: number | null;
    maxPositionNotional: number | null;
  };
  requestedNotional: number | null;
  usage: AllocationRiskUsage;
};

function isCompleteAllocation(
  allocation: AllocationRiskAccountSubscription['allocation']
) {
  return (
    allocation !== null &&
    isLimitEnabled(allocation.maxAllocatedNotional) &&
    isLimitEnabled(allocation.maxOpenPositions) &&
    isLimitEnabled(allocation.maxPositionNotional)
  );
}

function evaluateConfiguredHierarchyRisk(args: {
  tradingAccountId: number;
  maxDeployableNotional: number | null;
  accountSubscription: AllocationRiskAccountSubscription | null;
  requestedNotional: number | null;
}): RiskGateBlocked | null {
  if (!isLimitEnabled(args.maxDeployableNotional)) {
    return block(409, 'Trading account max deployable notional is not configured. New entries are blocked.', {
      rule: 'account_max_deployable_notional_required',
      tradingAccountId: args.tradingAccountId,
      maxDeployableNotional: args.maxDeployableNotional,
    });
  }

  const accountSubscription = args.accountSubscription;
  if (!accountSubscription?.enabled || !accountSubscription.entriesEnabled) {
    return null;
  }

  if (!accountSubscription.allocation) {
    return block(409, 'Entry-enabled account subscription is not assigned to an allocation. New entries are blocked.', {
      rule: 'account_subscription_allocation_required',
      tradingAccountId: args.tradingAccountId,
      tradingAccountSubscriptionId: accountSubscription.id,
      allocationId: accountSubscription.allocationId,
    });
  }

  // Preserve the established allocation-disabled block and its response details.
  if (!accountSubscription.allocation.enabled) {
    return null;
  }

  if (!isCompleteAllocation(accountSubscription.allocation)) {
    return block(409, 'Assigned allocation has incomplete risk limits. New entries are blocked.', {
      rule: 'allocation_limits_incomplete',
      tradingAccountId: args.tradingAccountId,
      tradingAccountSubscriptionId: accountSubscription.id,
      allocationId: accountSubscription.allocation.id,
      maxAllocatedNotional:
        accountSubscription.allocation.maxAllocatedNotional,
      maxOpenPositions: accountSubscription.allocation.maxOpenPositions,
      maxPositionNotional:
        accountSubscription.allocation.maxPositionNotional,
    });
  }

  if (!isLimitEnabled(accountSubscription.reservedNotional)) {
    return block(409, 'Entry-enabled account subscription has no reserved notional. New entries are blocked.', {
      rule: 'account_subscription_reservation_required',
      tradingAccountId: args.tradingAccountId,
      tradingAccountSubscriptionId: accountSubscription.id,
      allocationId: accountSubscription.allocation.id,
      reservedNotional: accountSubscription.reservedNotional,
    });
  }

  if (
    args.requestedNotional !== null &&
    args.requestedNotional > accountSubscription.reservedNotional
  ) {
    return block(409, 'Proposed entry notional exceeds the account subscription reservation.', {
      rule: 'account_subscription_reserved_notional_exceeded',
      tradingAccountId: args.tradingAccountId,
      tradingAccountSubscriptionId: accountSubscription.id,
      allocationId: accountSubscription.allocation.id,
      requestedNotional: args.requestedNotional,
      reservedNotional: accountSubscription.reservedNotional,
    });
  }

  return null;
}

function isEntryOrder(input: ResolvedPlaceOrderInput): boolean {
  return input.side === 'buy' && (input.signalType ?? 'entry') === 'entry';
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

async function getAllocationRiskAccountSubscription(
  input: ResolvedPlaceOrderInput,
  tradingAccountId: number
): Promise<AllocationRiskAccountSubscription | null> {
  if (input.subscriptionId === undefined) {
    return null;
  }

  return prisma.tradingAccountSubscription.findFirst({
    where: {
      tradingAccountId,
      subscriptionId: input.subscriptionId,
    },
    select: ALLOCATION_RISK_ACCOUNT_SUBSCRIPTION_SELECT,
  });
}

async function getAllocationRiskUsage(args: {
  tradingAccountId: number;
  allocationId: number;
  requestedNotional: number | null;
  excludeOrderIntentId?: number;
}): Promise<AllocationRiskUsage> {
  const [activePositions, pendingEntryOrders] = await Promise.all([
    prisma.trackedPosition.findMany({
      where: {
        tradingAccountId: args.tradingAccountId,
        status: {
          in: ACTIVE_POSITION_STATUSES,
        },
        tradingAccountSubscription: {
          is: {
            allocationId: args.allocationId,
          },
        },
      },
      select: {
        id: true,
        symbol: true,
        marketValue: true,
        costBasis: true,
        status: true,
        tradingAccountSubscriptionId: true,
      },
    }),

    prisma.orderIntent.findMany({
      where: {
        tradingAccountId: args.tradingAccountId,
        side: 'buy',
        trackedPositionId: null,
        status: {
          in: ENTRY_ORDER_STATUSES,
        },
        ...(args.excludeOrderIntentId
          ? { id: { not: args.excludeOrderIntentId } }
          : {}),
        tradingAccountSubscription: {
          is: {
            allocationId: args.allocationId,
          },
        },
      },
      select: {
        id: true,
        symbol: true,
        tradingAccountSubscriptionId: true,
        notional: true,
        qty: true,
        limitPrice: true,
        rawRequestJson: true,
        status: true,
      },
    }),
  ]);

  const openNotional = activePositions.reduce(
    (total, position) => total + getPositionExposure(position),
    0
  );

  const pendingEntryNotional = pendingEntryOrders.reduce((total, order) => {
    return total + (getOrderIntentEstimatedNotional(order) ?? 0);
  }, 0);

  const currentAllocatedNotional = openNotional + pendingEntryNotional;

  return {
    activePositionCount: activePositions.length,
    activeSymbols: Array.from(
      new Set(activePositions.map((position) => position.symbol))
    ),
    openNotional,
    pendingEntryOrderCount: pendingEntryOrders.length,
    pendingEntryNotional,
    currentAllocatedNotional,
    projectedAllocatedNotional:
      args.requestedNotional === null
        ? null
        : currentAllocatedNotional + args.requestedNotional,
  };
}

async function getAllocationRiskDetails(args: {
  accountSubscription: AllocationRiskAccountSubscription | null;
  tradingAccountId: number;
  requestedNotional: number | null;
  excludeOrderIntentId?: number;
}): Promise<AllocationRiskDetails | null> {
  const accountSubscription = args.accountSubscription;

  if (!accountSubscription || !accountSubscription.allocation) {
    return null;
  }

  const allocation = accountSubscription.allocation;

  const usage = await getAllocationRiskUsage({
    tradingAccountId: args.tradingAccountId,
    allocationId: allocation.id,
    requestedNotional: args.requestedNotional,
    ...(args.excludeOrderIntentId !== undefined
      ? { excludeOrderIntentId: args.excludeOrderIntentId }
      : {}),
  });

  return {
    tradingAccountSubscriptionId: accountSubscription.id,
    allocationId: allocation.id,
    allocationKey: allocation.key,
    allocationName: allocation.name,
    enabled: allocation.enabled,
    limits: {
      maxAllocatedNotional: allocation.maxAllocatedNotional,
      maxOpenPositions: allocation.maxOpenPositions,
      maxPositionNotional: allocation.maxPositionNotional,
    },
    requestedNotional: args.requestedNotional,
    usage,
  };
}

function allocationBlockDetails(
  allocationRisk: AllocationRiskDetails,
  details: Record<string, unknown>
) {
  return {
    allocationId: allocationRisk.allocationId,
    allocationKey: allocationRisk.allocationKey,
    allocationName: allocationRisk.allocationName,
    tradingAccountSubscriptionId:
      allocationRisk.tradingAccountSubscriptionId,
    ...details,
  };
}

function evaluateAllocationRisk(
  allocationRisk: AllocationRiskDetails | null
): RiskGateBlocked | null {
  if (!allocationRisk) {
    return null;
  }

  if (!allocationRisk.enabled) {
    return block(403, 'Allocation bucket is disabled for new entries.', {
      rule: 'allocation_disabled',
      ...allocationBlockDetails(allocationRisk, {
        enabled: allocationRisk.enabled,
      }),
    });
  }

  const requestedNotional = allocationRisk.requestedNotional;
  const maxPositionNotional = allocationRisk.limits.maxPositionNotional;

  if (
    requestedNotional !== null &&
    isLimitEnabled(maxPositionNotional) &&
    requestedNotional > maxPositionNotional
  ) {
    return block(
      409,
      'Allocation per-position notional limit would be exceeded.',
      {
        rule: 'allocation_max_position_notional_exceeded',
        ...allocationBlockDetails(allocationRisk, {
          limit: maxPositionNotional,
          requestedNotional,
        }),
      }
    );
  }

  const maxOpenPositions = allocationRisk.limits.maxOpenPositions;

  if (
    isLimitEnabled(maxOpenPositions) &&
    allocationRisk.usage.activePositionCount >= maxOpenPositions
  ) {
    return block(
      409,
      'Allocation maximum open position limit reached.',
      {
        rule: 'allocation_max_open_positions_exceeded',
        ...allocationBlockDetails(allocationRisk, {
          limit: maxOpenPositions,
          current: allocationRisk.usage.activePositionCount,
          projected: allocationRisk.usage.activePositionCount + 1,
          activeSymbols: allocationRisk.usage.activeSymbols,
        }),
      }
    );
  }

  const maxAllocatedNotional = allocationRisk.limits.maxAllocatedNotional;

  if (
    requestedNotional !== null &&
    allocationRisk.usage.projectedAllocatedNotional !== null &&
    isLimitEnabled(maxAllocatedNotional) &&
    allocationRisk.usage.projectedAllocatedNotional > maxAllocatedNotional
  ) {
    return block(
      409,
      'Allocation allocated notional limit would be exceeded.',
      {
        rule: 'allocation_max_allocated_notional_exceeded',
        ...allocationBlockDetails(allocationRisk, {
          limit: maxAllocatedNotional,
          current: allocationRisk.usage.currentAllocatedNotional,
          projected: allocationRisk.usage.projectedAllocatedNotional,
          requestedNotional,
          openNotional: allocationRisk.usage.openNotional,
          pendingEntryNotional: allocationRisk.usage.pendingEntryNotional,
        }),
      }
    );
  }

  return null;
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
  const tradingAccountId =
    options.tradingAccountId ?? (await resolveDefaultTradingAccountId());
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

  const entrySession =
    options.enforceEntrySessionGuard === false
      ? null
      : await evaluateEntrySessionGuard(config, new Date(), {
          tradingAccountId,
        });

  if (entrySession && isEntrySessionBlocked(entrySession)) {
    return {
      allowed: false,
      statusCode: entrySession.statusCode,
      reason: entrySession.reason,
      details: entrySessionDetailsAsJson(entrySession),
    };
  }

  const requestedNotional = getRequestedNotional(input, options);
  const [
    usage,
    accountRiskSettings,
    riskConfigurationAccount,
    allocationAccountSubscription,
  ] = await Promise.all([
    getTradingAccountEntryRiskUsage({
      tradingAccountId,
      symbol: input.symbol,
      ...(options.excludeOrderIntentId !== undefined
        ? { excludeOrderIntentId: options.excludeOrderIntentId }
        : {}),
    }),
    getAccountRiskSettings(tradingAccountId),
    prisma.tradingAccount.findUnique({
      where: { id: tradingAccountId },
      select: { maxDeployableNotional: true },
    }),
    getAllocationRiskAccountSubscription(input, tradingAccountId),
  ]);
  const effective = resolveEffectiveAccountEntryLimits({
    tradingAccountId,
    maxDeployableNotional:
      riskConfigurationAccount?.maxDeployableNotional ?? null,
    accountRiskSettings,
    globalConfig: config,
  });

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

  const dailyOrderLimit = effective.limits.maxDailyEntryOrders;
  if (
    isLimitEnabled(dailyOrderLimit.value) &&
    usage.dailyEntryOrderCount + 1 > dailyOrderLimit.value
  ) {
    return block(409, 'Account daily entry order limit would be exceeded.', {
      rule: 'account_max_daily_entry_orders_exceeded',
      layer: 'account',
      tradingAccountId,
      field: 'maxDailyEntryOrders',
      source: dailyOrderLimit.source,
      current: usage.dailyEntryOrderCount,
      requested: 1,
      projected: usage.dailyEntryOrderCount + 1,
      limit: dailyOrderLimit.value,
      dailyWindow: usage.dailyWindow,
    });
  }

  const positionLimit = effective.limits.maxOpenPositions;
  if (
    isLimitEnabled(positionLimit.value) &&
    usage.currentAccountPositionSlots + 1 > positionLimit.value
  ) {
    return block(409, 'Account maximum position capacity would be exceeded.', {
      rule: 'account_max_open_positions_exceeded',
      layer: 'account',
      tradingAccountId,
      field: 'maxOpenPositions',
      source: positionLimit.source,
      activePositionCount: usage.activePositionCount,
      pendingEntryPositionCount: usage.pendingEntryPositionCount,
      current: usage.currentAccountPositionSlots,
      requested: 1,
      projected: usage.currentAccountPositionSlots + 1,
      limit: positionLimit.value,
      activeSymbols: usage.activeSymbols,
      pendingSymbols: usage.pendingSymbols,
    });
  }

  const maxDeployableNotional = effective.authoritativeTotalExposure.value;
  if (!isLimitEnabled(maxDeployableNotional)) {
    return block(409, 'Trading account max deployable notional is not configured. New entries are blocked.', {
      rule: 'account_max_deployable_notional_required',
      layer: 'account',
      tradingAccountId,
      field: 'maxDeployableNotional',
      maxDeployableNotional,
    });
  }

  if (requestedNotional === null) {
    return block(409, 'Proposed entry notional is required for account risk evaluation.', {
      rule: 'account_entry_notional_required',
      layer: 'account',
      tradingAccountId,
      field: 'requestedNotional',
      requestedNotional,
    });
  }

  const dailyNotionalLimit = effective.limits.maxDailyEntryNotional;
  if (
    isLimitEnabled(dailyNotionalLimit.value) &&
    usage.dailyEntryNotional + requestedNotional > dailyNotionalLimit.value
  ) {
    return block(409, 'Account daily entry notional limit would be exceeded.', {
      rule: 'account_max_daily_entry_notional_exceeded',
      layer: 'account',
      tradingAccountId,
      field: 'maxDailyEntryNotional',
      source: dailyNotionalLimit.source,
      current: usage.dailyEntryNotional,
      requested: requestedNotional,
      projected: usage.dailyEntryNotional + requestedNotional,
      limit: dailyNotionalLimit.value,
      dailyWindow: usage.dailyWindow,
    });
  }

  const projectedAccountExposure =
    usage.currentAccountExposure + requestedNotional;
  if (
    projectedAccountExposure > maxDeployableNotional
  ) {
    return block(409, 'Trading account deployable exposure would be exceeded.', {
      rule: 'account_max_deployable_notional_exceeded',
      layer: 'account',
      tradingAccountId,
      field: 'maxDeployableNotional',
      source: 'TRADING_ACCOUNT',
      openPositionNotional: usage.openPositionNotional,
      pendingEntryNotional: usage.pendingEntryNotional,
      currentAccountExposure: usage.currentAccountExposure,
      requestedNotional,
      projectedAccountExposure,
      maxDeployableNotional,
    });
  }

  const symbolLimit = effective.limits.maxSymbolOpenNotional;
  const projectedSymbolExposure =
    usage.currentSymbolExposure + requestedNotional;
  if (
    isLimitEnabled(symbolLimit.value) &&
    projectedSymbolExposure > symbolLimit.value
  ) {
    return block(409, `Account symbol exposure limit would be exceeded for ${input.symbol}.`, {
      rule: 'account_max_symbol_open_notional_exceeded',
      layer: 'account',
      tradingAccountId,
      field: 'maxSymbolOpenNotional',
      source: symbolLimit.source,
      symbol: input.symbol,
      openSymbolNotional: usage.symbolOpenNotional,
      pendingSymbolNotional: usage.symbolPendingEntryNotional,
      currentSymbolExposure: usage.currentSymbolExposure,
      requestedNotional,
      projectedSymbolExposure,
      maxSymbolOpenNotional: symbolLimit.value,
    });
  }

  // Compatibility-only limits remain for an entry that cannot resolve an
  // account subscription. Resolved subscriptions use deployable capital,
  // allocation limits, reservation, and sizing as their authoritative layers.
  const unresolvedAccountSubscription = !allocationAccountSubscription;
  const legacyAccountTotalLimit =
    accountRiskSettings?.enabled &&
    isLimitEnabled(accountRiskSettings.maxTotalOpenNotional)
      ? {
          value: accountRiskSettings.maxTotalOpenNotional,
          source: 'ACCOUNT' as const,
        }
      : {
          value: config.maxTotalOpenNotional,
          source: 'LEGACY_GLOBAL_FALLBACK' as const,
        };
  if (
    unresolvedAccountSubscription &&
    isLimitEnabled(legacyAccountTotalLimit.value) &&
    projectedAccountExposure > legacyAccountTotalLimit.value
  ) {
    return block(409, 'Legacy total open notional fallback would be exceeded.', {
      rule: 'maxTotalOpenNotional',
      layer: 'legacy_compatibility',
      tradingAccountId,
      field: 'maxTotalOpenNotional',
      source: legacyAccountTotalLimit.source,
      current: usage.currentAccountExposure,
      requested: requestedNotional,
      projected: projectedAccountExposure,
      limit: legacyAccountTotalLimit.value,
    });
  }

  const subscriptionId = input.subscriptionId;
  if (unresolvedAccountSubscription && subscriptionId !== undefined) {
    const legacySubscriptionLimit =
      accountRiskSettings?.enabled &&
      isLimitEnabled(accountRiskSettings.maxSubscriptionOpenNotional)
        ? {
            value: accountRiskSettings.maxSubscriptionOpenNotional,
            source: 'ACCOUNT' as const,
          }
        : {
            value: config.maxSubscriptionOpenNotional,
            source: 'LEGACY_GLOBAL_FALLBACK' as const,
          };
    const openSubscriptionNotional = getSubscriptionOpenNotional(
      usage.activePositions,
      subscriptionId
    );
    const pendingSubscriptionNotional =
      usage.pendingEntryNotionalBySubscriptionId.get(subscriptionId) ?? 0;
    const currentSubscriptionExposure =
      openSubscriptionNotional + pendingSubscriptionNotional;
    const projectedSubscriptionExposure =
      currentSubscriptionExposure + requestedNotional;

    if (
      isLimitEnabled(legacySubscriptionLimit.value) &&
      projectedSubscriptionExposure > legacySubscriptionLimit.value
    ) {
      return block(
        409,
        'Legacy subscription open notional fallback would be exceeded.',
        {
          rule: 'maxSubscriptionOpenNotional',
          layer: 'legacy_compatibility',
          tradingAccountId,
          subscriptionId,
          field: 'maxSubscriptionOpenNotional',
          source: legacySubscriptionLimit.source,
          openSubscriptionNotional,
          pendingSubscriptionNotional,
          current: currentSubscriptionExposure,
          requested: requestedNotional,
          projected: projectedSubscriptionExposure,
          limit: legacySubscriptionLimit.value,
        }
      );
    }
  }

  const configuredHierarchyRisk = evaluateConfiguredHierarchyRisk({
    tradingAccountId,
    maxDeployableNotional:
      riskConfigurationAccount?.maxDeployableNotional ?? null,
    accountSubscription: allocationAccountSubscription,
    requestedNotional,
  });
  if (configuredHierarchyRisk) return configuredHierarchyRisk;

  const allocationRisk = await getAllocationRiskDetails({
    accountSubscription: allocationAccountSubscription,
    tradingAccountId,
    requestedNotional,
    ...(options.excludeOrderIntentId !== undefined
      ? { excludeOrderIntentId: options.excludeOrderIntentId }
      : {}),
  });
  const allocationRiskResult = evaluateAllocationRisk(allocationRisk);

  if (allocationRiskResult) {
    return allocationRiskResult;
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
      entrySession: entrySession?.details ?? {
        checked: false,
        reason: 'Entry session guard was not enforced for this evaluation.',
      },
      usage: {
        dailyEntryOrderCount: usage.dailyEntryOrderCount,
        dailyEntryNotional: usage.dailyEntryNotional,
        activePositionCount: usage.activePositionCount,
        pendingEntryPositionCount: usage.pendingEntryPositionCount,
        currentAccountPositionSlots: usage.currentAccountPositionSlots,
        openPositionNotional: usage.openPositionNotional,
        pendingEntryNotional: usage.pendingEntryNotional,
        currentAccountExposure: usage.currentAccountExposure,
        projectedAccountExposure,
        symbolOpenNotional: usage.symbolOpenNotional,
        symbolPendingEntryNotional: usage.symbolPendingEntryNotional,
        projectedSymbolExposure,
        activeSymbols: usage.activeSymbols,
      },
      effectiveEntryLimits: effective,
      allocationRisk,
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
  const usage = await getTradingAccountEntryRiskUsage({
    tradingAccountId,
    symbol: '',
  });

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
    usage.currentAccountExposure >= config.maxTotalOpenNotional
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
      totalOpenNotional: usage.currentAccountExposure,
      activeSymbols: usage.activeSymbols,
    },
  };
}
