import { PlatformRole } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  accountFindUnique: vi.fn(),
  positionFindMany: vi.fn(),
  getOrders: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({ prisma: {
  tradingAccount: { findMany: mocks.accountFindMany, findUnique: mocks.accountFindUnique },
  trackedPosition: { findMany: mocks.positionFindMany },
} }));
vi.mock('./orders.service.js', () => ({ getNormalizedOpenOrders: mocks.getOrders }));
vi.mock('./position-tracking.service.js', () => ({ getOpenTrackedPositionsForTradingAccount: vi.fn() }));

import { listScopedOpenOrders, listScopedOpenPositions } from './operational-scope.service.js';

const paper = { id: 1, displayName: 'Bobby Paper', broker: 'ALPACA', environment: 'PAPER', status: 'ACTIVE', accountHolder: { name: 'Bobby', email: 'bobby@example.com' }, credential: { status: 'ACTIVE' } };
const live = { id: 2, displayName: 'Bobby Live', broker: 'ALPACA', environment: 'LIVE', status: 'ACTIVE', accountHolder: { name: 'Bobby', email: 'bobby@example.com' }, credential: null };

beforeEach(() => vi.clearAllMocks());

describe('operational TradingAccount scope', () => {
  it('limits operator positions to membership-filtered account ids and preserves identity', async () => {
    mocks.accountFindMany.mockResolvedValue([paper]);
    mocks.positionFindMany.mockResolvedValue([{ id: 10, tradingAccountId: 1, symbol: 'DIA' }]);
    const result = await listScopedOpenPositions({ id: 9, platformRole: PlatformRole.OPERATOR });
    expect(mocks.accountFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { memberships: { some: { userId: 9 } } } }));
    expect(mocks.positionFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tradingAccountId: { in: [1] } }) }));
    expect(result[0]).toMatchObject({ tradingAccountId: 1, tradingAccount: { displayName: 'Bobby Paper', environment: 'PAPER', accountHolderName: 'Bobby' } });
  });

  it('returns broker truth per account and distinguishes missing credentials from an empty order list', async () => {
    mocks.accountFindMany.mockResolvedValue([paper, live]);
    mocks.getOrders.mockResolvedValue([]);
    const result = await listScopedOpenOrders({ id: 1, platformRole: PlatformRole.SYSTEM_OWNER });
    expect(mocks.getOrders).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({ availability: 'AVAILABLE', orders: [] });
    expect(result[1]).toMatchObject({ availability: 'UNAVAILABLE', reason: 'CREDENTIALS_MISSING', orders: null });
  });

  it('attributes a broker failure without failing other accounts', async () => {
    mocks.accountFindMany.mockResolvedValue([paper, { ...live, credential: { status: 'ACTIVE' } }]);
    mocks.getOrders.mockResolvedValueOnce([{ id: 'paper-order', symbol: 'DIA' }]).mockRejectedValueOnce(new Error('broker timeout'));
    const result = await listScopedOpenOrders({ id: 1, platformRole: PlatformRole.SYSTEM_OWNER });
    expect(result[0]).toMatchObject({ availability: 'AVAILABLE', orders: [{ tradingAccountId: 1 }] });
    expect(result[1]).toMatchObject({ account: { id: 2 }, availability: 'UNAVAILABLE', reason: 'BROKER_REQUEST_FAILED', message: 'broker timeout', orders: null });
  });

  it('rejects account portal users from admin-console ALL scope', async () => {
    await expect(listScopedOpenOrders({ id: 3, platformRole: PlatformRole.ACCOUNT_USER })).rejects.toMatchObject({ statusCode: 403 });
  });
});
