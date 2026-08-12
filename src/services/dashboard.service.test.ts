import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformRole } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  findAccount: vi.fn(), findAccounts: vi.fn(), groupPositions: vi.fn(), groupOrders: vi.fn(), findSnapshots: vi.fn(),
  getAccount: vi.fn(), getPositions: vi.fn(), getOrders: vi.fn(), getConfig: vi.fn(), getUsage: vi.fn(), evaluateSession: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({ prisma: {
  tradingAccount: { findUnique: mocks.findAccount, findMany: mocks.findAccounts },
  trackedPosition: { groupBy: mocks.groupPositions }, brokerOrder: { groupBy: mocks.groupOrders },
  accountSnapshot: { findMany: mocks.findSnapshots },
} }));
vi.mock('./account.service.js', () => ({ getNormalizedAccount: mocks.getAccount }));
vi.mock('./positions.service.js', () => ({ getNormalizedPositions: mocks.getPositions }));
vi.mock('./orders.service.js', () => ({ getNormalizedOpenOrders: mocks.getOrders }));
vi.mock('./config.service.js', () => ({ getRuntimeTradingConfig: mocks.getConfig }));
vi.mock('./trading-account-entry-risk-usage.service.js', () => ({ getTradingAccountEntryRiskUsage: mocks.getUsage }));
vi.mock('./entry-session-guard.service.js', () => ({ evaluateEntrySessionGuard: mocks.evaluateSession, isEntrySessionBlocked: (value: { allowed: boolean }) => !value.allowed }));

import { getDashboardAccountsOverview, getTradingAccountDashboard } from './dashboard.service.js';

function account(overrides: Record<string, unknown> = {}) {
  return { id: 2, displayName: 'Bobby Live', broker: 'ALPACA', environment: 'LIVE', status: 'NEEDS_CREDENTIALS', tradingEnabled: false, killSwitchEnabled: true, maxDeployableNotional: null, baseCurrency: 'USD', brokerAccountNumberMasked: null, brokerAccountStatus: null, tradingBlocked: null, lastBrokerSyncAt: null, lastCash: null, lastBuyingPower: null, lastEquity: null, lastPortfolioValue: null, accountHolder: { name: 'Bobby W', email: 'bobby@example.com' }, credential: null, riskSettings: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfig.mockResolvedValue({ tradingEnabled: true, killSwitchEnabled: false, entrySessionGuardEnabled: true, entryStartMinutesAfterOpen: 0, entryCutoffMinutesBeforeClose: null, failClosedOnMarketClockError: true, maxDailyEntryOrders: null, maxDailyEntryNotional: null, maxOpenPositions: null, maxTotalOpenNotional: null, maxSymbolOpenNotional: null, maxSubscriptionOpenNotional: null });
  mocks.getUsage.mockResolvedValue({ dailyEntryOrderCount: 0, dailyEntryNotional: 0, activePositionCount: 0, openPositionNotional: 0, pendingEntryNotional: 0, currentAccountExposure: 0, activeSymbols: [] });
});

describe('selected Trading Account Dashboard', () => {
  it('returns a useful disconnected LIVE account without broker calls or default-account resolution', async () => {
    mocks.findAccount.mockResolvedValue(account());
    const result = await getTradingAccountDashboard(2);
    expect(result.account).toMatchObject({ id: 2, environment: 'LIVE' });
    expect(result.credentials).toMatchObject({ status: 'MISSING', usable: false });
    expect(result.broker.available).toBe(false);
    expect(result.exposure.openPositionCount).toBeNull();
    expect(result.readiness.status).toBe('BLOCKED');
    expect(mocks.getAccount).not.toHaveBeenCalled();
    expect(mocks.getPositions).not.toHaveBeenCalled();
    expect(mocks.getOrders).not.toHaveBeenCalled();
  });
});

describe('ALL Dashboard overview', () => {
  it('uses membership scope for operators and returns no aggregate financial totals', async () => {
    mocks.findAccounts.mockResolvedValue([account({ id: 1, displayName: 'Bobby Paper', environment: 'PAPER' })]);
    mocks.groupPositions.mockResolvedValue([]); mocks.groupOrders.mockResolvedValue([]); mocks.findSnapshots.mockResolvedValue([]);
    const result = await getDashboardAccountsOverview({ id: 7, platformRole: PlatformRole.OPERATOR });
    expect(mocks.findAccounts).toHaveBeenCalledWith(expect.objectContaining({ where: { memberships: { some: { userId: 7 } } } }));
    expect(result.accounts[0]?.account.environment).toBe('PAPER');
    expect(result.summary).not.toHaveProperty('portfolioValue');
    expect(mocks.getAccount).not.toHaveBeenCalled();
  });

  it('limits ACCOUNT_USER overview to membership-authorized accounts', async () => {
    mocks.findAccounts.mockResolvedValue([]);
    const result = await getDashboardAccountsOverview({ id: 8, platformRole: PlatformRole.ACCOUNT_USER });
    expect(mocks.findAccounts).toHaveBeenCalledWith(expect.objectContaining({ where: { memberships: { some: { userId: 8 } } } }));
    expect(result.accounts).toEqual([]);
  });
});
