import type { PositionSizingType, Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type { ResolvedPlaceOrderInput } from '../validators/place-order.schema.js';
import {
  resolveRuntimeAccountSubscriptionSizing,
  type RuntimeAccountSubscriptionSizingResult,
} from './account-subscription-runtime-sizing.service.js';
import { getRuntimeTradingConfig } from './config.service.js';
import {
  entrySessionDetailsAsJson,
  evaluateEntrySessionGuard,
  isEntrySessionBlocked,
} from './entry-session-guard.service.js';
import { evaluateOrderRisk, type RiskGateBlocked } from './risk-gate.service.js';

const ACTIVE_POSITION_STATUSES = ['open', 'closing'];
const ENTRY_ORDER_STATUSES = ['pending', 'submitted', 'filled'];

const PREVIEW_TRADING_ACCOUNT_SELECT = {
  id: true,
  displayName: true,
  broker: true,
  environment: true,
  status: true,
} satisfies Prisma.TradingAccountSelect;

const PREVIEW_SUBSCRIPTION_SELECT = {
  id: true,
  key: true,
  symbol: true,
  enabled: true,
  strategy: {
    select: {
      enabled: true,
    },
  },
  exitProfile: {
    select: {
      enabled: true,
    },
  },
  security: {
    select: {
      enabled: true,
    },
  },
} satisfies Prisma.SubscriptionSelect;

const PREVIEW_ACCOUNT_SUBSCRIPTION_SELECT = {
  id: true,
  tradingAccountId: true,
  subscriptionId: true,
  allocationId: true,
  enabled: true,
  entriesEnabled: true,
  exitsEnabled: true,
  sizingType: true,
  fixedQty: true,
  maxPositionNotional: true,
  reservedNotional: true,
  minPositionNotional: true,
  maxQty: true,
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

type PreviewTradingAccount = Prisma.TradingAccountGetPayload<{
  select: typeof PREVIEW_TRADING_ACCOUNT_SELECT;
}>;

type PreviewSubscription = Prisma.SubscriptionGetPayload<{
  select: typeof PREVIEW_SUBSCRIPTION_SELECT;
}>;

type PreviewAccountSubscription = Prisma.TradingAccountSubscriptionGetPayload<{
  select: typeof PREVIEW_ACCOUNT_SUBSCRIPTION_SELECT;
}>;

type PreviewRiskLayer =
  | 'global'
  | 'account'
  | 'allocation'
  | 'subscription'
  | 'session'
  | 'unknown';

type AllocationRiskPreview = Awaited<ReturnType<typeof getAllocationRiskPreview>>;

export type EntryRiskPreviewInput = {
  subscriptionKey: string;
  ignoreSession?: boolean | undefined;
};

function getErrorCode(error: unknown) {
  if (error instanceof HttpError) {
    const details = error.details;

    if (details && typeof details === 'object' && !Array.isArray(details)) {
      const code = (details as Record<string, unknown>).code;
      const rule = (details as Record<string, unknown>).rule;

      if (typeof code === 'string') return code;
      if (typeof rule === 'string') return rule;
    }

    return error.message;
  }

  return 'entry_risk_preview_failed';
}

function getErrorDetails(error: unknown) {
  if (error instanceof HttpError) {
    return error.details ?? null;
  }

  return {
    message:
      error instanceof Error ? error.message : 'Entry risk preview failed.',
  };
}

function classifyRiskLayer(code: string | null): PreviewRiskLayer {
  if (!code) {
    return 'unknown';
  }

  if (
    code === 'tradingEnabled' ||
    code === 'killSwitchEnabled' ||
    code === 'maxDailyEntryOrders' ||
    code === 'maxOpenPositions' ||
    code === 'maxDailyEntryNotional' ||
    code === 'maxTotalOpenNotional' ||
    code === 'maxSymbolOpenNotional' ||
    code === 'maxSubscriptionOpenNotional' ||
    code.startsWith('broker_') ||
    code.startsWith('security_') ||
    code === 'one_active_position_per_symbol'
  ) {
    return 'global';
  }

  if (code.startsWith('account_subscription_')) {
    return 'subscription';
  }

  if (code.startsWith('account_')) {
    return 'account';
  }

  if (code.startsWith('allocation_')) {
    return 'allocation';
  }

  if (
    code.startsWith('subscription_') ||
    code === 'subscription_exists' ||
    code === 'subscription_enabled' ||
    code === 'strategy_enabled' ||
    code === 'exit_profile_enabled'
  ) {
    return 'subscription';
  }

  if (
    code === 'market_closed' ||
    code === 'entry_open_buffer_active' ||
    code === 'entry_close_buffer_active' ||
    code === 'market_clock_unavailable' ||
    code === 'entry_window_unavailable'
  ) {
    return 'session';
  }

  return 'unknown';
}

function getRuleFromDetails(details: unknown) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }

  const rule = (details as Record<string, unknown>).rule;

  return typeof rule === 'string' ? rule : null;
}

function isLimitEnabled(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
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

function allocationRiskBlock(args: {
  code: string;
  message: string;
  details: Record<string, unknown>;
}) {
  return {
    ok: false,
    code: args.code,
    layer: 'allocation' as const,
    message: args.message,
    details: {
      rule: args.code,
      ...args.details,
    },
  };
}

async function getAllocationRiskPreview(args: {
  accountSubscription: PreviewAccountSubscription | null;
  requestedNotional: number | null;
}) {
  const accountSubscription = args.accountSubscription;
  const allocation = accountSubscription?.allocation;

  if (!accountSubscription || !allocation) {
    return {
      checked: false,
      ok: true,
      code: null,
      layer: null,
      message: 'No allocation is assigned to this account subscription.',
      details: null,
    };
  }

  const allocationAccountSubscriptions =
    await prisma.tradingAccountSubscription.findMany({
      where: {
        tradingAccountId: accountSubscription.tradingAccountId,
        allocationId: allocation.id,
      },
      select: {
        id: true,
        subscriptionId: true,
      },
    });
  const allocationAccountSubscriptionIds =
    allocationAccountSubscriptions.map((record) => record.id);
  const allocationSubscriptionIds = allocationAccountSubscriptions.map(
    (record) => record.subscriptionId
  );
  const allocationMembershipWhere = {
    OR: [
      {
        tradingAccountSubscriptionId: {
          in: allocationAccountSubscriptionIds,
        },
      },
      {
        subscriptionId: {
          in: allocationSubscriptionIds,
        },
      },
    ],
  };
  const [activePositions, pendingEntryOrders] = await Promise.all([
    prisma.trackedPosition.findMany({
      where: {
        tradingAccountId: accountSubscription.tradingAccountId,
        status: {
          in: ACTIVE_POSITION_STATUSES,
        },
        ...allocationMembershipWhere,
      },
      select: {
        id: true,
        symbol: true,
        subscriptionId: true,
        tradingAccountSubscriptionId: true,
        marketValue: true,
        costBasis: true,
        status: true,
      },
    }),
    prisma.orderIntent.findMany({
      where: {
        tradingAccountId: accountSubscription.tradingAccountId,
        side: 'buy',
        status: {
          in: ENTRY_ORDER_STATUSES,
        },
        ...allocationMembershipWhere,
      },
      select: {
        id: true,
        symbol: true,
        subscriptionId: true,
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
  const projectedAllocatedNotional =
    args.requestedNotional === null
      ? null
      : currentAllocatedNotional + args.requestedNotional;
  const details = {
    tradingAccountSubscriptionId: accountSubscription.id,
    allocationId: allocation.id,
    allocationKey: allocation.key,
    allocationName: allocation.name,
    allocationAccountSubscriptionIds,
    allocationSubscriptionIds,
    enabled: allocation.enabled,
    limits: {
      maxAllocatedNotional: allocation.maxAllocatedNotional,
      maxOpenPositions: allocation.maxOpenPositions,
      maxPositionNotional: allocation.maxPositionNotional,
    },
    requestedNotional: args.requestedNotional,
    usage: {
      activePositionCount: activePositions.length,
      activeSymbols: Array.from(
        new Set(activePositions.map((position) => position.symbol))
      ),
      openNotional,
      pendingEntryOrderCount: pendingEntryOrders.length,
      pendingEntryNotional,
      currentAllocatedNotional,
      projectedAllocatedNotional,
    },
  };

  if (!allocation.enabled) {
    return {
      checked: true,
      ...allocationRiskBlock({
        code: 'allocation_disabled',
        message: 'Allocation bucket is disabled for new entries.',
        details,
      }),
    };
  }

  if (
    args.requestedNotional !== null &&
    isLimitEnabled(allocation.maxPositionNotional) &&
    args.requestedNotional > allocation.maxPositionNotional
  ) {
    return {
      checked: true,
      ...allocationRiskBlock({
        code: 'allocation_max_position_notional_exceeded',
        message: 'Allocation per-position notional limit would be exceeded.',
        details: {
          ...details,
          limit: allocation.maxPositionNotional,
        },
      }),
    };
  }

  if (
    isLimitEnabled(allocation.maxOpenPositions) &&
    activePositions.length >= allocation.maxOpenPositions
  ) {
    return {
      checked: true,
      ...allocationRiskBlock({
        code: 'allocation_max_open_positions_exceeded',
        message: 'Allocation maximum open position limit reached.',
        details: {
          ...details,
          limit: allocation.maxOpenPositions,
          current: activePositions.length,
          projected: activePositions.length + 1,
        },
      }),
    };
  }

  if (
    projectedAllocatedNotional !== null &&
    isLimitEnabled(allocation.maxAllocatedNotional) &&
    projectedAllocatedNotional > allocation.maxAllocatedNotional
  ) {
    return {
      checked: true,
      ...allocationRiskBlock({
        code: 'allocation_max_allocated_notional_exceeded',
        message: 'Allocation allocated notional limit would be exceeded.',
        details: {
          ...details,
          limit: allocation.maxAllocatedNotional,
          current: currentAllocatedNotional,
          projected: projectedAllocatedNotional,
        },
      }),
    };
  }

  return {
    checked: true,
    ok: true,
    code: null,
    layer: 'allocation' as const,
    message: null,
    details,
  };
}

function serializeSizing(args: {
  accountSubscription: PreviewAccountSubscription | null;
  sizing: RuntimeAccountSubscriptionSizingResult | null;
  error: unknown;
}) {
  const snapshot = args.sizing?.snapshot;
  const code = args.error ? getErrorCode(args.error) : null;
  const details = args.error ? getErrorDetails(args.error) : null;

  return {
    ok: !args.error && args.sizing !== null,
    code,
    message: args.error instanceof HttpError ? args.error.message : null,
    details,
    sizingType:
      snapshot?.sizingType ?? args.accountSubscription?.sizingType ?? null,
    fixedQty: snapshot?.fixedQty ?? args.accountSubscription?.fixedQty ?? null,
    maxPositionNotional:
      snapshot?.maxPositionNotional ??
      args.accountSubscription?.maxPositionNotional ??
      null,
    minPositionNotional:
      snapshot?.minPositionNotional ??
      args.accountSubscription?.minPositionNotional ??
      null,
    maxQty: snapshot?.maxQty ?? args.accountSubscription?.maxQty ?? null,
    latestPrice:
      snapshot?.latestPrice ??
      (details && typeof details === 'object' && !Array.isArray(details)
        ? ((details as Record<string, unknown>).latestPrice as number | null) ??
          null
        : null),
    latestPriceAt: snapshot?.latestPriceAt ?? null,
    latestPriceSource: snapshot?.latestPriceSource ?? null,
    calculatedQty: snapshot?.calculatedQty ?? null,
    estimatedNotional: snapshot?.estimatedNotional ?? null,
  };
}

function serializeRisk(result: Awaited<ReturnType<typeof evaluateOrderRisk>>) {
  if (result.allowed) {
    return {
      ok: true,
      code: null,
      layer: null,
      message: null,
      details: result.details,
    };
  }

  const code = getRuleFromDetails(result.details) ?? result.reason;

  return {
    ok: false,
    code,
    layer: classifyRiskLayer(code),
    message: result.reason,
    details: result.details,
  };
}

function serializeRiskFromError(error: unknown) {
  const code = getErrorCode(error);

  return {
    ok: false,
    code,
    layer: classifyRiskLayer(code),
    message: error instanceof HttpError ? error.message : 'Risk preview failed.',
    details: getErrorDetails(error),
  };
}

async function getSessionPreview(
  tradingAccountId: number,
  ignoreSession: boolean
) {
  if (!ignoreSession) {
    return {
      checked: false,
      note: 'Session checks are enforced only by the real entry path. Preview did not enforce them.',
    };
  }

  try {
    const config = await getRuntimeTradingConfig();
    const decision = await evaluateEntrySessionGuard(config, new Date(), {
      tradingAccountId,
    });
    const details = entrySessionDetailsAsJson(decision) as Record<
      string,
      unknown
    >;
    const blocked = isEntrySessionBlocked(decision);

    return {
      checked: true,
      marketOpen:
        typeof details.marketOpen === 'boolean' ? details.marketOpen : null,
      entryWindowOpen: decision.allowed,
      wouldBlockRealEntryNow: blocked,
      code: blocked ? decision.details.rule : null,
      message: blocked ? decision.reason : null,
      details,
    };
  } catch (error) {
    return {
      checked: false,
      note: 'Session checks are not enforced for preview.',
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'UnknownError', message: 'Unable to check session state.' },
    };
  }
}

function serializeAccountSubscription(
  accountSubscription: PreviewAccountSubscription | null
) {
  return accountSubscription
    ? {
        id: accountSubscription.id,
        enabled: accountSubscription.enabled,
        entriesEnabled: accountSubscription.entriesEnabled,
        exitsEnabled: accountSubscription.exitsEnabled,
        allocationId: accountSubscription.allocationId,
        sizingType: accountSubscription.sizingType,
        reservedNotional: accountSubscription.reservedNotional,
      }
    : null;
}

function serializeAllocation(
  accountSubscription: PreviewAccountSubscription | null
) {
  const allocation = accountSubscription?.allocation;

  return allocation
    ? {
        id: allocation.id,
        key: allocation.key,
        name: allocation.name,
        enabled: allocation.enabled,
        maxAllocatedNotional: allocation.maxAllocatedNotional,
        maxOpenPositions: allocation.maxOpenPositions,
        maxPositionNotional: allocation.maxPositionNotional,
      }
    : null;
}

function buildRiskInput(args: {
  tradingAccountId: number;
  subscription: PreviewSubscription;
  sizing: RuntimeAccountSubscriptionSizingResult;
  subscriptionKey: string;
}): ResolvedPlaceOrderInput {
  return {
    tradingAccountSubscriptionId:
      args.sizing.tradingAccountSubscriptionId,
    tradingAccountId: args.tradingAccountId,
    subscriptionKey: args.subscriptionKey,
    subscriptionId: args.subscription.id,
    symbol: args.subscription.symbol,
    side: 'buy',
    orderType: 'market',
    timeInForce: 'day',
    qty: args.sizing.qty,
    extendedHours: false,
    signalType: 'entry',
  };
}

function serializePreviewBase(args: {
  account: PreviewTradingAccount;
  subscription: PreviewSubscription;
  accountSubscription: PreviewAccountSubscription | null;
  sizing: ReturnType<typeof serializeSizing>;
  risk: ReturnType<typeof serializeRisk> | ReturnType<typeof serializeRiskFromError>;
  allocationRisk: AllocationRiskPreview;
  session: Awaited<ReturnType<typeof getSessionPreview>>;
}) {
  const ok = args.sizing.ok && args.risk.ok && args.allocationRisk.ok;
  const riskDetails =
    args.risk.details &&
    typeof args.risk.details === 'object' &&
    !Array.isArray(args.risk.details)
      ? (args.risk.details as Record<string, unknown>)
      : null;

  return {
    ok,
    wouldSubmitIfSessionAllowed: ok,
    tradingAccount: args.account,
    subscription: {
      id: args.subscription.id,
      key: args.subscription.key,
      symbol: args.subscription.symbol,
      enabled: args.subscription.enabled,
    },
    accountSubscription: serializeAccountSubscription(args.accountSubscription),
    allocation: serializeAllocation(args.accountSubscription),
    sizing: args.sizing,
    risk: args.risk,
    effectiveEntryLimits: riskDetails?.effectiveEntryLimits ?? null,
    accountUsage: riskDetails?.usage ?? null,
    blockingLayer: args.risk.ok ? null : args.risk.layer,
    blockingCode: args.risk.ok ? null : args.risk.code,
    allocationRisk: args.allocationRisk,
    session: args.session,
    wouldCreateOrderIntent: false,
    wouldSubmitBrokerOrder: false,
  };
}

export async function previewTradingAccountEntryRisk(
  tradingAccountId: number,
  input: EntryRiskPreviewInput
) {
  const ignoreSession = input.ignoreSession ?? true;
  const [account, subscription] = await Promise.all([
    prisma.tradingAccount.findUnique({
      where: { id: tradingAccountId },
      select: PREVIEW_TRADING_ACCOUNT_SELECT,
    }),
    prisma.subscription.findUnique({
      where: { key: input.subscriptionKey },
      select: PREVIEW_SUBSCRIPTION_SELECT,
    }),
  ]);

  if (!account) {
    return null;
  }

  if (!subscription) {
    throw new HttpError(
      404,
      `Subscription ${input.subscriptionKey} was not found.`
    );
  }

  const accountSubscription =
    await prisma.tradingAccountSubscription.findFirst({
      where: {
        tradingAccountId,
        subscriptionId: subscription.id,
      },
      select: PREVIEW_ACCOUNT_SUBSCRIPTION_SELECT,
    });
  const session = await getSessionPreview(tradingAccountId, ignoreSession);
  let sizing: RuntimeAccountSubscriptionSizingResult | null = null;
  let sizingError: unknown = null;

  try {
    if (!accountSubscription) {
      throw new HttpError(
        409,
        'Trading account subscription assignment is required for risk preview.'
      );
    }
    sizing = await resolveRuntimeAccountSubscriptionSizing({
      tradingAccountSubscriptionId: accountSubscription.id,
      tradingAccountId,
      subscriptionId: subscription.id,
      symbol: subscription.symbol,
    });
  } catch (error) {
    sizingError = error;
  }

  const sizingPreview = serializeSizing({
    accountSubscription,
    sizing,
    error: sizingError,
  });

  if (!sizing || sizingError) {
    return serializePreviewBase({
      account,
      subscription,
      accountSubscription,
      sizing: sizingPreview,
      risk: serializeRiskFromError(sizingError),
      allocationRisk: await getAllocationRiskPreview({
        accountSubscription,
        requestedNotional: null,
      }),
      session,
    });
  }

  const riskInput = buildRiskInput({
    tradingAccountId,
    subscription,
    sizing,
    subscriptionKey: input.subscriptionKey,
  });
  const riskResult = await evaluateOrderRisk(riskInput, {
    tradingAccountId,
    enforceEntrySessionGuard: !ignoreSession,
    requestedNotionalOverride: sizing.estimatedNotional,
  });

  return serializePreviewBase({
    account,
    subscription,
    accountSubscription,
    sizing: sizingPreview,
    risk: serializeRisk(riskResult),
    allocationRisk: await getAllocationRiskPreview({
      accountSubscription,
      requestedNotional: sizing.estimatedNotional,
    }),
    session,
  });
}
