import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformRole } from '@prisma/client';

import { PlatformPermission } from '../types/platform-rbac.js';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  membershipFindMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    tradingAccountMembership: { findMany: mocks.membershipFindMany },
  },
}));

import { getUserAccessMetadata } from './user-access.service.js';

describe('user access metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.membershipFindMany.mockResolvedValue([]);
  });

  it('returns unrestricted account scope for system owners', async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: 1,
      platformRole: PlatformRole.SYSTEM_OWNER,
    });

    await expect(getUserAccessMetadata(1)).resolves.toEqual({
      platformRole: PlatformRole.SYSTEM_OWNER,
      permissions: Object.values(PlatformPermission),
      accessibleTradingAccountIds: null,
    });
    expect(mocks.membershipFindMany).not.toHaveBeenCalled();
  });

  it.each([
    PlatformRole.OPERATOR,
    PlatformRole.ACCOUNT_USER,
  ])('returns duplicate-free membership scope without changing %s permissions', async (platformRole) => {
    mocks.userFindUnique.mockResolvedValue({ id: 2, platformRole });
    mocks.membershipFindMany.mockResolvedValue([
      { tradingAccountId: 8 },
      { tradingAccountId: 3 },
      { tradingAccountId: 8 },
    ]);

    const metadata = await getUserAccessMetadata(2);

    expect(metadata.accessibleTradingAccountIds).toEqual([8, 3]);
    expect(metadata.permissions).toEqual(
      platformRole === PlatformRole.OPERATOR
        ? [
            PlatformPermission.TRADING_ACCOUNT_READ,
            PlatformPermission.TRADING_ACCOUNT_WRITE,
            PlatformPermission.TRADING_ACCOUNT_RISK_WRITE,
            PlatformPermission.SUBSCRIPTION_READ,
            PlatformPermission.SUBSCRIPTION_WRITE,
            PlatformPermission.STRATEGY_READ,
            PlatformPermission.EXIT_PROFILE_READ,
            PlatformPermission.REPORTS_READ,
          ]
        : [
            PlatformPermission.TRADING_ACCOUNT_READ,
            PlatformPermission.SUBSCRIPTION_READ,
            PlatformPermission.STRATEGY_READ,
            PlatformPermission.EXIT_PROFILE_READ,
            PlatformPermission.REPORTS_READ,
            PlatformPermission.SYSTEM_EVENTS_READ,
          ],
    );
    expect(mocks.membershipFindMany).toHaveBeenCalledWith({
      where: { userId: 2 },
      select: { tradingAccountId: true },
    });
  });
});
