/**
 * Admin access and permission service.
 * Computes permissions and accessible resources for admin users.
 */

import { getPlatformPermissionsForRole, isSystemOwnerRole } from '../types/platform-rbac.js';
import { prisma } from '../db/prisma.js';

export interface AdminAccessMetadata {
  platformRole: string;
  permissions: string[];
  accessibleTradingAccountIds: number[] | null;
}

/**
 * Get access metadata for an admin user.
 * Returns the user's role, permissions, and accessible trading accounts.
 *
 * System owners have unrestricted access to all trading accounts (null signals "all").
 * Other roles: specific trading account IDs based on TradingAccountAccess records.
 */
export async function getAdminAccessMetadata(userId: number): Promise<AdminAccessMetadata> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, platformRole: true },
  });

  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const permissions = getPlatformPermissionsForRole(user.platformRole);

  // System owners have unrestricted access (null signals "all trading accounts").
  if (isSystemOwnerRole(user.platformRole)) {
    return {
      platformRole: user.platformRole,
      permissions,
      accessibleTradingAccountIds: null,
    };
  }

  // For other roles, fetch specific trading accounts this user has access to
  const accessRecords = await prisma.tradingAccountAccess.findMany({
    where: { adminUserId: userId },
    select: { tradingAccountId: true },
  });

  const accessibleTradingAccountIds = accessRecords.map((r) => r.tradingAccountId);

  return {
    platformRole: user.platformRole,
    permissions,
    accessibleTradingAccountIds,
  };
}
