import { PlatformRole } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import {
  getPlatformPermissionsForRole,
  isSystemOwnerRole,
  type PlatformPermission,
} from '../types/platform-rbac.js';

export interface UserAccessMetadata {
  platformRole: PlatformRole;
  permissions: PlatformPermission[];
  accessibleTradingAccountIds: number[] | null;
}

export async function getUserAccessMetadata(
  userId: number,
): Promise<UserAccessMetadata> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, platformRole: true },
  });

  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const permissions = getPlatformPermissionsForRole(user.platformRole);

  if (isSystemOwnerRole(user.platformRole)) {
    return {
      platformRole: user.platformRole,
      permissions,
      accessibleTradingAccountIds: null,
    };
  }

  const memberships = await prisma.tradingAccountMembership.findMany({
    where: { userId },
    select: { tradingAccountId: true },
  });

  return {
    platformRole: user.platformRole,
    permissions,
    accessibleTradingAccountIds: [
      ...new Set(memberships.map((membership) => membership.tradingAccountId)),
    ],
  };
}
