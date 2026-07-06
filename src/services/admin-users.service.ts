/**
 * Admin users management service.
 * Handles reading admin user data and their trading account access assignments.
 */

import { prisma } from '../db/prisma.js';

export interface AdminUserWithAccess {
  id: number;
  email: string;
  name: string | null;
  role: string;
  enabled: boolean;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserTradingAccountAccess {
  id: number;
  tradingAccountId: number;
  displayName: string;
  role: string;
  canView: boolean;
  canPauseTrading: boolean;
  canResumeTrading: boolean;
  canEditRiskSettings: boolean;
  canEditStrategySettings: boolean;
  canEditCredentials: boolean;
  canManageAccess: boolean;
}

/**
 * List all admin users with their basic information.
 * Does not expose password hashes or sensitive data.
 */
export async function listAdminUsers(): Promise<AdminUserWithAccess[]> {
  const users = await prisma.adminUser.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      enabled: true,
      emailVerifiedAt: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { email: 'asc' },
  });

  return users;
}

/**
 * Get a single admin user by ID.
 * Does not expose password hashes or sensitive data.
 */
export async function getAdminUserById(
  id: number,
): Promise<AdminUserWithAccess | null> {
  const user = await prisma.adminUser.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      enabled: true,
      emailVerifiedAt: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return user;
}

/**
 * Get all trading accounts a user has access to.
 * For owner role, returns all trading accounts.
 * For other roles, returns only accounts with explicit TradingAccountAccess records.
 */
export async function getAdminUserTradingAccountAccess(
  userId: number,
): Promise<AdminUserTradingAccountAccess[]> {
  const user = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user) {
    return [];
  }

  // Owner role can access all trading accounts
  if (user.role === 'owner' || user.role === 'admin') {
    const accounts = await prisma.tradingAccount.findMany({
      select: {
        id: true,
        displayName: true,
      },
      orderBy: { displayName: 'asc' },
    });

    return accounts.map((account) => ({
      id: 0, // Synthetic id for owner access (not from TradingAccountAccess table)
      tradingAccountId: account.id,
      displayName: account.displayName,
      role: 'OWNER',
      canView: true,
      canPauseTrading: true,
      canResumeTrading: true,
      canEditRiskSettings: true,
      canEditStrategySettings: true,
      canEditCredentials: true,
      canManageAccess: true,
    }));
  }

  // Other roles: fetch explicit access records
  const accesses = await prisma.tradingAccountAccess.findMany({
    where: { adminUserId: userId },
    select: {
      id: true,
      tradingAccountId: true,
      tradingAccount: {
        select: {
          displayName: true,
        },
      },
      role: true,
      canView: true,
      canPauseTrading: true,
      canResumeTrading: true,
      canEditRiskSettings: true,
      canEditStrategySettings: true,
      canEditCredentials: true,
      canManageAccess: true,
    },
    orderBy: { tradingAccount: { displayName: 'asc' } },
  });

  return accesses.map((access) => ({
    id: access.id,
    tradingAccountId: access.tradingAccountId,
    displayName: access.tradingAccount.displayName,
    role: access.role,
    canView: access.canView,
    canPauseTrading: access.canPauseTrading,
    canResumeTrading: access.canResumeTrading,
    canEditRiskSettings: access.canEditRiskSettings,
    canEditStrategySettings: access.canEditStrategySettings,
    canEditCredentials: access.canEditCredentials,
    canManageAccess: access.canManageAccess,
  }));
}
