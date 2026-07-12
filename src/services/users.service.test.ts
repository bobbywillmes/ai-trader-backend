import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformRole } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(), userFindUnique: vi.fn(), userCreate: vi.fn(), userUpdate: vi.fn(), userCount: vi.fn(),
  accountFindMany: vi.fn(), membershipFindMany: vi.fn(), membershipDeleteMany: vi.fn(), membershipCreate: vi.fn(),
  tokenUpdateMany: vi.fn(), tokenCreate: vi.fn(), transaction: vi.fn(), audit: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    user: { findMany: mocks.userFindMany, findUnique: mocks.userFindUnique, create: mocks.userCreate, update: mocks.userUpdate, count: mocks.userCount },
    tradingAccount: { findMany: mocks.accountFindMany },
    tradingAccountMembership: { findMany: mocks.membershipFindMany, deleteMany: mocks.membershipDeleteMany, create: mocks.membershipCreate },
    userSetupToken: { updateMany: mocks.tokenUpdateMany, create: mocks.tokenCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock('./admin-audit.service.js', () => ({ createAdminAuditEvent: mocks.audit }));

import {
  createUserInvitation,
  getUserTradingAccountMemberships,
  regenerateUserSetupLink,
  replaceUserTradingAccountMemberships,
  updateUser,
} from './users.service.js';

const date = new Date('2026-07-11T00:00:00Z');
const baseUser = {
  id: 2, email: 'user@example.com', name: 'User', platformRole: PlatformRole.ACCOUNT_USER,
  enabled: true, emailVerifiedAt: null, invitedAt: date, setupCompletedAt: null,
  lastLoginAt: null, createdAt: date, updatedAt: date,
};

describe('users service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audit.mockResolvedValue(undefined);
    mocks.accountFindMany.mockResolvedValue([]);
    mocks.membershipFindMany.mockResolvedValue([]);
    mocks.membershipDeleteMany.mockResolvedValue({ count: 0 });
    mocks.membershipCreate.mockResolvedValue({});
    mocks.tokenUpdateMany.mockResolvedValue({ count: 0 });
    mocks.tokenCreate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (input: unknown) =>
      typeof input === 'function'
        ? input({ user: { create: mocks.userCreate } })
        : Promise.all(input as Promise<unknown>[]),
    );
  });

  it.each([PlatformRole.ACCOUNT_USER, PlatformRole.OPERATOR, PlatformRole.SYSTEM_OWNER])(
    'invites a %s with deduplicated memberships and a transactional setup token',
    async (platformRole) => {
      mocks.accountFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      mocks.userFindUnique.mockResolvedValue(null);
      mocks.userCreate.mockResolvedValue({ ...baseUser, platformRole });

      const result = await createUserInvitation(-1, {
        email: baseUser.email, platformRole, enabled: true, tradingAccountIds: [1, 2, 1],
      });

      expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          platformRole,
          invitedByUserId: null,
          tradingAccountMemberships: { create: [{ tradingAccountId: 1 }, { tradingAccountId: 2 }] },
          setupTokens: { create: expect.objectContaining({ tokenHash: expect.any(String) }) },
        }),
      }));
      expect(result).toEqual(expect.objectContaining({
        user: expect.objectContaining({ platformRole }),
        setupLink: expect.objectContaining({ userId: 2 }),
      }));
    },
  );

  it('rejects invalid accounts and duplicate emails', async () => {
    mocks.accountFindMany.mockResolvedValueOnce([]);
    await expect(createUserInvitation(1, {
      email: baseUser.email, platformRole: PlatformRole.ACCOUNT_USER, enabled: true, tradingAccountIds: [99],
    })).rejects.toMatchObject({ statusCode: 400 });

    mocks.userFindUnique.mockResolvedValue({ id: 2 });
    await expect(createUserInvitation(1, {
      email: baseUser.email, platformRole: PlatformRole.ACCOUNT_USER, enabled: true, tradingAccountIds: [],
    })).rejects.toThrow('A user with this email already exists.');
  });

  it('regenerates setup links with UserSetupToken and rejects completed setup', async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ id: 2, invitedAt: date, setupCompletedAt: null, passwordHash: null });
    const link = await regenerateUserSetupLink(2, -1);
    expect(mocks.tokenUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 2, usedAt: null, revokedAt: null } }));
    expect(mocks.tokenCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 2 }) }));
    expect(link.userId).toBe(2);

    mocks.userFindUnique.mockResolvedValueOnce({ id: 2, invitedAt: date, setupCompletedAt: date, passwordHash: 'hash' });
    await expect(regenerateUserSetupLink(2, 1)).rejects.toThrow('User setup is already complete.');
  });

  it('lists only explicit memberships, including for system owners', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 2, platformRole: PlatformRole.SYSTEM_OWNER });
    mocks.membershipFindMany.mockResolvedValue([{ id: 7, tradingAccountId: 3, createdAt: date, updatedAt: date, tradingAccount: { displayName: 'Paper' } }]);
    await expect(getUserTradingAccountMemberships(2)).resolves.toEqual([{ id: 7, tradingAccountId: 3, displayName: 'Paper', createdAt: date, updatedAt: date }]);
    expect(mocks.membershipFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 2 } }));
  });

  it('replaces memberships transactionally while preserving retained rows', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 2 });
    mocks.accountFindMany.mockResolvedValueOnce([{ id: 2 }, { id: 3 }]).mockResolvedValueOnce([]);
    mocks.membershipFindMany
      .mockResolvedValueOnce([{ id: 10, tradingAccountId: 1 }, { id: 11, tradingAccountId: 2 }])
      .mockResolvedValueOnce([{ id: 11, tradingAccountId: 2, createdAt: date, updatedAt: date, tradingAccount: { displayName: 'A' } }]);

    await replaceUserTradingAccountMemberships(2, { tradingAccountIds: [2, 3] });
    expect(mocks.membershipDeleteMany).toHaveBeenCalledWith({ where: { id: { in: [10] } } });
    expect(mocks.membershipCreate).toHaveBeenCalledWith({ data: { userId: 2, tradingAccountId: 3 } });
    expect(mocks.membershipCreate).not.toHaveBeenCalledWith({ data: { userId: 2, tradingAccountId: 2 } });
  });

  it('rejects removal of holder membership but permits removal for non-holders and empty lists', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 2 });
    mocks.accountFindMany.mockResolvedValueOnce([{ id: 1 }]);
    await expect(replaceUserTradingAccountMemberships(2, { tradingAccountIds: [] })).rejects.toThrow(
      "Cannot remove a Trading Account membership while the user is that account's account holder.",
    );

    mocks.accountFindMany.mockResolvedValueOnce([]);
    mocks.membershipFindMany.mockResolvedValueOnce([{ id: 10, tradingAccountId: 1 }]).mockResolvedValueOnce([]);
    await expect(replaceUserTradingAccountMemberships(2, { tradingAccountIds: [] })).resolves.toEqual([]);
    expect(mocks.membershipDeleteMany).toHaveBeenCalledWith({ where: { id: { in: [10] } } });
  });

  it('updates user fields without touching memberships and prevents self role changes', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 2, platformRole: PlatformRole.OPERATOR });
    mocks.userUpdate.mockResolvedValue({ ...baseUser, name: 'Updated', platformRole: PlatformRole.OPERATOR, enabled: false });
    await updateUser(2, 1, { name: 'Updated', platformRole: PlatformRole.OPERATOR, enabled: false });
    expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Updated', platformRole: PlatformRole.OPERATOR, enabled: false } }));
    expect(mocks.membershipDeleteMany).not.toHaveBeenCalled();
    expect(mocks.membershipCreate).not.toHaveBeenCalled();

    await expect(updateUser(2, 2, { platformRole: PlatformRole.ACCOUNT_USER })).rejects.toThrow('Cannot change your own platform role.');
  });

  it('protects the final system owner from demotion and disablement', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 2, platformRole: PlatformRole.SYSTEM_OWNER });
    mocks.userCount.mockResolvedValue(1);
    await expect(updateUser(2, 1, { platformRole: PlatformRole.OPERATOR })).rejects.toThrow('Cannot demote the final system owner.');
    await expect(updateUser(2, 1, { enabled: false })).rejects.toThrow('Cannot disable the final enabled system owner.');
  });
});
