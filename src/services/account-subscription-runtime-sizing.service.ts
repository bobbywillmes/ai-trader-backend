import { PositionSizingType, Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import {
  getTickerLatestPrice,
  type TickerLatestPrice,
} from './massive-market-data.service.js';

const RUNTIME_ACCOUNT_SUBSCRIPTION_SELECT = {
  id: true,
  tradingAccountId: true,
  subscriptionId: true,
  enabled: true,
  entriesEnabled: true,
  sizingType: true,
  fixedQty: true,
  maxPositionNotional: true,
  minPositionNotional: true,
  maxQty: true,
  subscription: {
    select: {
      id: true,
      key: true,
      symbol: true,
    },
  },
} satisfies Prisma.TradingAccountSubscriptionSelect;

type RuntimeAccountSubscriptionRecord =
  Prisma.TradingAccountSubscriptionGetPayload<{
    select: typeof RUNTIME_ACCOUNT_SUBSCRIPTION_SELECT;
  }>;

export type AccountSubscriptionSizingSnapshot = {
  tradingAccountSubscriptionId: number;
  sizingType: PositionSizingType;
  fixedQty: number | null;
  maxPositionNotional: number | null;
  minPositionNotional: number | null;
  maxQty: number | null;
  latestPrice: number | null;
  latestPriceAt: string | null;
  latestPriceSource: string | null;
  calculatedQty: number;
  estimatedNotional: number | null;
};

export type RuntimeAccountSubscriptionSizingResult = {
  tradingAccountSubscriptionId: number;
  qty: number;
  estimatedNotional: number | null;
  accountSubscription: RuntimeAccountSubscriptionRecord;
  snapshot: AccountSubscriptionSizingSnapshot;
};

type ResolveRuntimeAccountSubscriptionSizingArgs = {
  tradingAccountId: number;
  subscriptionId: number;
  symbol: string;
};

function isPositiveFiniteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function runtimeSizingError(
  statusCode: number,
  code: string,
  details: Record<string, unknown>
) {
  return new HttpError(statusCode, code, {
    code,
    rule: code,
    ...details,
  });
}

function buildSnapshot(args: {
  accountSubscription: RuntimeAccountSubscriptionRecord;
  latest: TickerLatestPrice | null;
  calculatedQty: number;
  estimatedNotional: number | null;
}): AccountSubscriptionSizingSnapshot {
  return {
    tradingAccountSubscriptionId: args.accountSubscription.id,
    sizingType: args.accountSubscription.sizingType,
    fixedQty: args.accountSubscription.fixedQty,
    maxPositionNotional: args.accountSubscription.maxPositionNotional,
    minPositionNotional: args.accountSubscription.minPositionNotional,
    maxQty: args.accountSubscription.maxQty,
    latestPrice: args.latest?.latestPrice ?? null,
    latestPriceAt: args.latest?.latestPriceAt ?? null,
    latestPriceSource: args.latest?.latestPriceSource ?? null,
    calculatedQty: args.calculatedQty,
    estimatedNotional: args.estimatedNotional,
  };
}

function applyMaxQtyCap(args: {
  qty: number;
  accountSubscription: RuntimeAccountSubscriptionRecord;
}) {
  if (!isPositiveFiniteNumber(args.accountSubscription.maxQty)) {
    return args.qty;
  }

  const maxQty = Math.floor(args.accountSubscription.maxQty);

  return Math.min(args.qty, maxQty);
}

async function getRequiredLatestPrice(args: {
  symbol: string;
  tradingAccountId: number;
  subscriptionId: number;
  tradingAccountSubscriptionId: number;
}) {
  try {
    const latest = await getTickerLatestPrice(args.symbol);

    if (!isPositiveFiniteNumber(latest.latestPrice)) {
      throw runtimeSizingError(409, 'latest_price_unavailable', {
        tradingAccountId: args.tradingAccountId,
        subscriptionId: args.subscriptionId,
        tradingAccountSubscriptionId: args.tradingAccountSubscriptionId,
        symbol: args.symbol,
        latestPrice: latest.latestPrice,
        latestPriceAt: latest.latestPriceAt,
        latestPriceSource: latest.latestPriceSource,
      });
    }

    return latest;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw runtimeSizingError(409, 'latest_price_unavailable', {
      tradingAccountId: args.tradingAccountId,
      subscriptionId: args.subscriptionId,
      tradingAccountSubscriptionId: args.tradingAccountSubscriptionId,
      symbol: args.symbol,
    });
  }
}

function enforceMinPositionNotional(args: {
  accountSubscription: RuntimeAccountSubscriptionRecord;
  latest: TickerLatestPrice | null;
  qty: number;
  estimatedNotional: number | null;
}) {
  const minPositionNotional = args.accountSubscription.minPositionNotional;

  if (minPositionNotional === null) {
    return;
  }

  if (!isPositiveFiniteNumber(args.latest?.latestPrice ?? null)) {
    throw runtimeSizingError(409, 'latest_price_unavailable', {
      tradingAccountId: args.accountSubscription.tradingAccountId,
      subscriptionId: args.accountSubscription.subscriptionId,
      tradingAccountSubscriptionId: args.accountSubscription.id,
      symbol: args.accountSubscription.subscription.symbol,
    });
  }

  if (
    args.estimatedNotional === null ||
    args.estimatedNotional < minPositionNotional
  ) {
    throw runtimeSizingError(409, 'min_position_notional_not_met', {
      tradingAccountId: args.accountSubscription.tradingAccountId,
      subscriptionId: args.accountSubscription.subscriptionId,
      tradingAccountSubscriptionId: args.accountSubscription.id,
      symbol: args.accountSubscription.subscription.symbol,
      qty: args.qty,
      latestPrice: args.latest?.latestPrice ?? null,
      estimatedNotional: args.estimatedNotional,
      minPositionNotional,
    });
  }
}

async function resolveLatestPriceIfNeeded(args: {
  accountSubscription: RuntimeAccountSubscriptionRecord;
  symbol: string;
}) {
  return getRequiredLatestPrice({
    symbol: args.symbol,
    tradingAccountId: args.accountSubscription.tradingAccountId,
    subscriptionId: args.accountSubscription.subscriptionId,
    tradingAccountSubscriptionId: args.accountSubscription.id,
  });
}

export async function resolveRuntimeAccountSubscriptionSizing(
  args: ResolveRuntimeAccountSubscriptionSizingArgs
): Promise<RuntimeAccountSubscriptionSizingResult> {
  const accountSubscription =
    await prisma.tradingAccountSubscription.findFirst({
      where: {
        tradingAccountId: args.tradingAccountId,
        subscriptionId: args.subscriptionId,
      },
      select: RUNTIME_ACCOUNT_SUBSCRIPTION_SELECT,
    });

  if (!accountSubscription) {
    throw runtimeSizingError(409, 'account_subscription_missing', {
      tradingAccountId: args.tradingAccountId,
      subscriptionId: args.subscriptionId,
    });
  }

  if (!accountSubscription.enabled) {
    throw runtimeSizingError(403, 'account_subscription_disabled', {
      tradingAccountId: args.tradingAccountId,
      subscriptionId: args.subscriptionId,
      tradingAccountSubscriptionId: accountSubscription.id,
    });
  }

  if (!accountSubscription.entriesEnabled) {
    throw runtimeSizingError(403, 'account_subscription_entries_disabled', {
      tradingAccountId: args.tradingAccountId,
      subscriptionId: args.subscriptionId,
      tradingAccountSubscriptionId: accountSubscription.id,
    });
  }

  const latest = await resolveLatestPriceIfNeeded({
    accountSubscription,
    symbol: args.symbol,
  });
  const latestPrice = latest?.latestPrice ?? null;
  let qty: number;

  if (accountSubscription.sizingType === PositionSizingType.FIXED_QTY) {
    const fixedQty = accountSubscription.fixedQty;

    if (!isPositiveFiniteNumber(fixedQty)) {
      throw runtimeSizingError(409, 'invalid_fixed_qty_sizing', {
        tradingAccountId: args.tradingAccountId,
        subscriptionId: args.subscriptionId,
        tradingAccountSubscriptionId: accountSubscription.id,
        fixedQty: accountSubscription.fixedQty,
      });
    }

    qty = Math.floor(fixedQty);

    if (qty < 1) {
      throw runtimeSizingError(409, 'invalid_fixed_qty_sizing', {
        tradingAccountId: args.tradingAccountId,
        subscriptionId: args.subscriptionId,
        tradingAccountSubscriptionId: accountSubscription.id,
        fixedQty: accountSubscription.fixedQty,
      });
    }
  } else {
    const maxPositionNotional = accountSubscription.maxPositionNotional;

    if (!isPositiveFiniteNumber(maxPositionNotional)) {
      throw runtimeSizingError(409, 'invalid_max_notional_sizing', {
        tradingAccountId: args.tradingAccountId,
        subscriptionId: args.subscriptionId,
        tradingAccountSubscriptionId: accountSubscription.id,
        maxPositionNotional: accountSubscription.maxPositionNotional,
      });
    }

    if (!isPositiveFiniteNumber(latestPrice)) {
      throw runtimeSizingError(409, 'latest_price_unavailable', {
        tradingAccountId: args.tradingAccountId,
        subscriptionId: args.subscriptionId,
        tradingAccountSubscriptionId: accountSubscription.id,
        symbol: args.symbol,
      });
    }

    qty = Math.floor(maxPositionNotional / latestPrice);

    if (qty < 1) {
      throw runtimeSizingError(409, 'max_notional_below_share_price', {
        tradingAccountId: args.tradingAccountId,
        subscriptionId: args.subscriptionId,
        tradingAccountSubscriptionId: accountSubscription.id,
        symbol: args.symbol,
        latestPrice,
        maxPositionNotional,
      });
    }
  }

  qty = applyMaxQtyCap({ qty, accountSubscription });

  if (qty < 1) {
    throw runtimeSizingError(409, 'max_notional_below_share_price', {
      tradingAccountId: args.tradingAccountId,
      subscriptionId: args.subscriptionId,
      tradingAccountSubscriptionId: accountSubscription.id,
      symbol: args.symbol,
      latestPrice,
      maxQty: accountSubscription.maxQty,
    });
  }

  const estimatedNotional =
    latestPrice === null ? null : qty * latestPrice;

  enforceMinPositionNotional({
    accountSubscription,
    latest,
    qty,
    estimatedNotional,
  });

  return {
    tradingAccountSubscriptionId: accountSubscription.id,
    qty,
    estimatedNotional,
    accountSubscription,
    snapshot: buildSnapshot({
      accountSubscription,
      latest,
      calculatedQty: qty,
      estimatedNotional,
    }),
  };
}
