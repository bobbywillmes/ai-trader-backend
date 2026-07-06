/**
 * Admin access and permission service.
 * Computes permissions and accessible resources for admin users.
 */

import { getPermissionsForRole } from '../types/admin-rbac.js';
import { prisma } from '../db/prisma.js';

export interface AdminAccessMetadata {
  role: string;
  permissions: string[];
  accessibleTradingAccountIds: number[] | null;
}

/**
 * Get access metadata for an admin user.
 * Returns the user's role, permissions, and accessible trading accounts.
 *
 * Owner role: unrestricted access to all trading accounts (null signals "all").
 * Other roles: specific trading account IDs based on TradingAccountAccess records.
 */
export async function getAdminAccessMetadata(adminUserId: number): Promise<AdminAccessMetadata> {
  const adminUser = await prisma.adminUser.findUnique({
    where: { id: adminUserId },
    select: { id: true, role: true },
  });

  if (!adminUser) {
    throw new Error(`Admin user ${adminUserId} not found`);
  }

  const permissions = getPermissionsForRole(adminUser.role);

  // Owner role has unrestricted access (null signals "all trading accounts")
  if (adminUser.role === 'owner') {
    return {
      role: adminUser.role,
      permissions,
      accessibleTradingAccountIds: null,
    };
  }

  // For other roles, fetch specific trading accounts this user has access to
  const accessRecords = await prisma.tradingAccountAccess.findMany({
    where: { adminUserId },
    select: { tradingAccountId: true },
  });

  const accessibleTradingAccountIds = accessRecords.map((r) => r.tradingAccountId);

  return {
    role: adminUser.role,
    permissions,
    accessibleTradingAccountIds,
  };
}
