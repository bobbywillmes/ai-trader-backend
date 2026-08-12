import { PlatformRole, type Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { getNormalizedAccount } from './account.service.js';
import { getNormalizedOpenOrders } from './orders.service.js';
import { getNormalizedPositions } from './positions.service.js';
import { getRuntimeTradingConfig } from './config.service.js';
import { evaluateEntrySessionGuard, isEntrySessionBlocked } from './entry-session-guard.service.js';
import { getTradingAccountEntryRiskUsage } from './trading-account-entry-risk-usage.service.js';
import { resolveEffectiveAccountEntryLimits } from './trading-account-entry-risk-limits.service.js';
import { NONTERMINAL_BROKER_ORDER_PRISMA_FILTER } from './broker-order-lifecycle-status.service.js';

const ACTIVE_POSITION_STATUSES = ['open', 'closing'];

const DASHBOARD_ACCOUNT_SELECT = {
  id: true, displayName: true, broker: true, environment: true, status: true,
  tradingEnabled: true, killSwitchEnabled: true, maxDeployableNotional: true,
  baseCurrency: true, brokerAccountNumberMasked: true, brokerAccountStatus: true,
  tradingBlocked: true, lastBrokerSyncAt: true, lastCash: true, lastBuyingPower: true,
  lastEquity: true, lastPortfolioValue: true,
  accountHolder: { select: { name: true, email: true } },
  credential: { select: { status: true, verifiedAt: true, lastFailedAt: true, revokedAt: true } },
  riskSettings: true,
} satisfies Prisma.TradingAccountSelect;

type DashboardAccount = Prisma.TradingAccountGetPayload<{ select: typeof DASHBOARD_ACCOUNT_SELECT }>;

function credentialSummary(account: DashboardAccount) {
  return {
    exists: account.credential !== null,
    status: account.credential?.status ?? 'MISSING',
    usable: account.credential?.status === 'ACTIVE',
    verifiedAt: account.credential?.verifiedAt ?? null,
    lastFailedAt: account.credential?.lastFailedAt ?? null,
    revokedAt: account.credential?.revokedAt ?? null,
  };
}

function identity(account: DashboardAccount) {
  return {
    id: account.id, displayName: account.displayName,
    accountHolderName: account.accountHolder.name ?? account.accountHolder.email,
    broker: account.broker, environment: account.environment, status: account.status,
    baseCurrency: account.baseCurrency,
    brokerAccountNumberMasked: account.brokerAccountNumberMasked,
    brokerAccountStatus: account.brokerAccountStatus,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Data could not be obtained.';
}

export async function getTradingAccountEntryReadiness(
  account: DashboardAccount,
  brokerAccount: Awaited<ReturnType<typeof getNormalizedAccount>> | null,
) {
  const evaluatedAt = new Date();
  const credentials = credentialSummary(account);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (account.status !== 'ACTIVE') blockers.push(`Account operational status is ${account.status}.`);
  if (!account.tradingEnabled) blockers.push('Trading is disabled for this Trading Account.');
  if (account.killSwitchEnabled) blockers.push('This Trading Account kill switch is enabled.');
  if (!credentials.usable) blockers.push(credentials.exists ? `Broker credentials are ${credentials.status}.` : 'Broker credentials are missing.');
  if (brokerAccount?.tradingBlocked) blockers.push('Broker account reports trading is blocked.');

  const [configResult, usageResult] = await Promise.allSettled([
    getRuntimeTradingConfig(),
    getTradingAccountEntryRiskUsage({ tradingAccountId: account.id, symbol: '' }),
  ]);
  const config = configResult.status === 'fulfilled' ? configResult.value : null;
  const usage = usageResult.status === 'fulfilled' ? usageResult.value : null;
  if (!config) blockers.push('System trading configuration is unavailable.');
  if (!usage) blockers.push('Account risk usage is unavailable.');

  let entrySession = null;
  if (config && credentials.usable) {
    const decision = await evaluateEntrySessionGuard(config, evaluatedAt, { tradingAccountId: account.id });
    entrySession = { ...decision.details, canEnterNow: decision.allowed, degraded: decision.allowed && decision.degraded, rule: isEntrySessionBlocked(decision) ? decision.details.rule : null };
    if (!decision.allowed) blockers.push(decision.reason);
    else if (decision.degraded) warnings.push('Market-session status is degraded.');
  }

  const effectiveLimits = config ? resolveEffectiveAccountEntryLimits({
    tradingAccountId: account.id,
    maxDeployableNotional: account.maxDeployableNotional,
    accountRiskSettings: account.riskSettings,
    globalConfig: config,
  }) : null;
  if (config && !config.tradingEnabled) blockers.push('Global emergency trading control is disabled.');
  if (config?.killSwitchEnabled) blockers.push('Global emergency kill switch is enabled.');
  if (effectiveLimits?.usingLegacyGlobalFallback) warnings.push('Some entry limits use legacy global fallback values.');

  const uniqueBlockers = [...new Set(blockers)];
  return {
    status: uniqueBlockers.length ? 'BLOCKED' : warnings.length ? 'READY_WITH_WARNINGS' : 'READY',
    canEnter: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    warnings,
    evaluatedAt: evaluatedAt.toISOString(),
    entrySession,
    usage: usage ? {
      dailyEntryOrderCount: usage.dailyEntryOrderCount,
      dailyEntryNotional: usage.dailyEntryNotional,
      activePositionCount: usage.activePositionCount,
      openPositionNotional: usage.openPositionNotional,
      pendingEntryNotional: usage.pendingEntryNotional,
      totalOpenNotional: usage.currentAccountExposure,
      activeSymbols: usage.activeSymbols,
    } : null,
    effectiveLimits,
    systemBlockers: {
      tradingEnabled: config?.tradingEnabled ?? null,
      killSwitchEnabled: config?.killSwitchEnabled ?? null,
    },
  };
}

export async function getTradingAccountDashboard(tradingAccountId: number) {
  const account = await prisma.tradingAccount.findUnique({ where: { id: tradingAccountId }, select: DASHBOARD_ACCOUNT_SELECT });
  if (!account) throw new HttpError(404, 'Trading Account not found.');
  const credentials = credentialSummary(account);
  let brokerAccount: Awaited<ReturnType<typeof getNormalizedAccount>> | null = null;
  let positions: Awaited<ReturnType<typeof getNormalizedPositions>> | null = null;
  let openOrders: Awaited<ReturnType<typeof getNormalizedOpenOrders>> | null = null;
  const errors: Record<string, string> = {};
  if (credentials.usable) {
    const [accountResult, positionsResult, ordersResult] = await Promise.allSettled([
      getNormalizedAccount(tradingAccountId, 'account_snapshot'),
      getNormalizedPositions(tradingAccountId, 'tracked_position_sync'),
      getNormalizedOpenOrders(tradingAccountId, 'open_orders_sync'),
    ]);
    if (accountResult.status === 'fulfilled') brokerAccount = accountResult.value; else errors.account = errorMessage(accountResult.reason);
    if (positionsResult.status === 'fulfilled') positions = positionsResult.value; else errors.positions = errorMessage(positionsResult.reason);
    if (ordersResult.status === 'fulfilled') openOrders = ordersResult.value; else errors.orders = errorMessage(ordersResult.reason);
  } else {
    errors.broker = 'Usable broker credentials are not available.';
  }
  const readiness = await getTradingAccountEntryReadiness(account, brokerAccount);
  return {
    account: identity(account), credentials,
    safety: { tradingEnabled: account.tradingEnabled, killSwitchEnabled: account.killSwitchEnabled },
    broker: brokerAccount ? { available: true, observedAt: new Date().toISOString(), account: brokerAccount } : { available: false, observedAt: null, account: null, error: errors.account ?? errors.broker },
    exposure: {
      openPositionNotional: readiness.usage?.openPositionNotional ?? null,
      pendingEntryNotional: readiness.usage?.pendingEntryNotional ?? null,
      openPositionCount: positions?.length ?? null, openOrderCount: openOrders?.length ?? null,
      positions, openOrders,
    },
    readiness, partialFailures: errors,
  };
}

export async function getDashboardAccountsOverview(user: { id: number; platformRole: PlatformRole }) {
  const where = user.platformRole === PlatformRole.SYSTEM_OWNER ? {} : { memberships: { some: { userId: user.id } } };
  const accounts = await prisma.tradingAccount.findMany({ where, select: DASHBOARD_ACCOUNT_SELECT, orderBy: { id: 'asc' } });
  const ids = accounts.map((account) => account.id);
  const [positions, orderCounts, snapshots] = ids.length ? await Promise.all([
    prisma.trackedPosition.groupBy({ by: ['tradingAccountId'], where: { tradingAccountId: { in: ids }, status: { in: ACTIVE_POSITION_STATUSES } }, _count: { _all: true }, _sum: { marketValue: true } }),
    prisma.brokerOrder.groupBy({ by: ['tradingAccountId'], where: { tradingAccountId: { in: ids }, status: NONTERMINAL_BROKER_ORDER_PRISMA_FILTER }, _count: { _all: true } }),
    prisma.accountSnapshot.findMany({ where: { tradingAccountId: { in: ids } }, orderBy: { createdAt: 'desc' }, distinct: ['tradingAccountId'] }),
  ]) : [[], [], []];
  const positionMap = new Map(positions.map((row) => [row.tradingAccountId, row]));
  const orderMap = new Map(orderCounts.map((row) => [row.tradingAccountId, row._count._all]));
  const snapshotMap = new Map(snapshots.map((snapshot) => [snapshot.tradingAccountId, snapshot]));
  const now = Date.now();
  const rows = accounts.map((account) => {
    const credential = credentialSummary(account); const snapshot = snapshotMap.get(account.id); const blockers: string[] = [];
    if (!credential.usable) blockers.push(credential.exists ? `Credentials ${credential.status.toLowerCase()}` : 'Credentials missing');
    if (account.status !== 'ACTIVE') blockers.push(`Status ${account.status.toLowerCase()}`);
    if (!account.tradingEnabled) blockers.push('Trading disabled');
    if (account.killSwitchEnabled) blockers.push('Kill switch enabled');
    if (snapshot?.tradingBlocked || account.tradingBlocked) blockers.push('Broker trading blocked');
    const stale = !snapshot || now - snapshot.createdAt.getTime() > 15 * 60_000;
    if (stale) blockers.push(snapshot ? 'Broker snapshot stale' : 'Broker data unavailable');
    return {
      account: identity(account), credentials: credential,
      safety: { tradingEnabled: account.tradingEnabled, killSwitchEnabled: account.killSwitchEnabled },
      readiness: { status: blockers.length ? (snapshot ? 'BLOCKED' : 'UNAVAILABLE') : 'READY', primaryBlocker: blockers[0] ?? null, blockers },
      exposure: { openPositionCount: positionMap.get(account.id)?._count._all ?? 0, openOrderCount: orderMap.get(account.id) ?? 0, openPositionNotional: Math.abs(positionMap.get(account.id)?._sum.marketValue ?? 0) },
      financialSnapshot: snapshot ? { portfolioValue: snapshot.portfolioValue, equity: snapshot.equity, cash: snapshot.cash, buyingPower: snapshot.buyingPower, dayPnL: snapshot.dayPnL, dayPnLPct: snapshot.dayPnLPct } : null,
      freshness: { observedAt: snapshot?.createdAt ?? null, stale, available: Boolean(snapshot) },
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      tradingAccountCount: rows.length, paperCount: rows.filter((r) => r.account.environment === 'PAPER').length,
      liveCount: rows.filter((r) => r.account.environment === 'LIVE').length,
      readyCount: rows.filter((r) => r.readiness.status === 'READY').length,
      blockedCount: rows.filter((r) => r.readiness.status === 'BLOCKED').length,
      unavailableCount: rows.filter((r) => r.readiness.status === 'UNAVAILABLE').length,
      attentionCount: rows.filter((r) => r.readiness.status !== 'READY').length,
      openPositionCount: rows.reduce((sum, r) => sum + r.exposure.openPositionCount, 0),
      openOrderCount: rows.reduce((sum, r) => sum + r.exposure.openOrderCount, 0),
    },
    accounts: rows,
  };
}
