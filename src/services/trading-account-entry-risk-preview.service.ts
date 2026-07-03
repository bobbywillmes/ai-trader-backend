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

export type EntryRiskPreviewInput = {
  subscriptionKey: string;
  ignoreSession?: boolean;
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
  subscription: PreviewSubscription;
  sizing: RuntimeAccountSubscriptionSizingResult;
  subscriptionKey: string;
}): ResolvedPlaceOrderInput {
  return {
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
  session: Awaited<ReturnType<typeof getSessionPreview>>;
}) {
  const ok = args.sizing.ok && args.risk.ok;

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
    sizing = await resolveRuntimeAccountSubscriptionSizing({
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
      session,
    });
  }

  const riskInput = buildRiskInput({
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
    session,
  });
}
