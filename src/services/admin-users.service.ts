/**
 * Admin users management service.
 * Handles reading and updating admin user data and their trading account access assignments.
 */

import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { createAdminAuditEvent } from './admin-audit.service.js';
import type {
  CreateAdminUserInvitationInput,
  UpdateAdminUserTradingAccountAccessInput,
} from '../validators/admin-users.schema.js';

const ADMIN_SETUP_TOKEN_BYTES = 32;
const ADMIN_SETUP_TOKEN_TTL_DAYS = 7;
const INVITABLE_ADMIN_ROLES = ['owner', 'account_manager', 'account_viewer'];

function createRawSetupToken() {
  return crypto.randomBytes(ADMIN_SETUP_TOKEN_BYTES).toString('base64url');
}

function hashSetupToken(rawToken: string) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function buildSetupTokenExpirationDate() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + ADMIN_SETUP_TOKEN_TTL_DAYS);
  return expiresAt;
}

function buildSetupPath(rawToken: string) {
  return `/setup-account?token=${encodeURIComponent(rawToken)}`;
}

function isPendingSetup(user: {
  invitedAt: Date | null;
  setupCompletedAt: Date | null;
}) {
  return Boolean(user.invitedAt && !user.setupCompletedAt);
}

function assertInvitableRole(role: string) {
  if (!INVITABLE_ADMIN_ROLES.includes(role)) {
    throw new HttpError(400, `Invalid role: ${role}`);
  }
}

function normalizeAccessAssignments(
  assignments: Array<{ tradingAccountId: number; role: string }>,
) {
  const deduped = new Map<number, 'OWNER' | 'MANAGER' | 'VIEWER'>();

  for (const assignment of assignments) {
    deduped.set(
      assignment.tradingAccountId,
      assignment.role as 'OWNER' | 'MANAGER' | 'VIEWER',
    );
  }

  return [...deduped.entries()].map(([tradingAccountId, role]) => ({
    tradingAccountId,
    role,
  }));
}

async function assertTradingAccountsExist(tradingAccountIds: number[]) {
  const uniqueIds = [...new Set(tradingAccountIds)];

  if (uniqueIds.length === 0) {
    return;
  }

  const accounts = await prisma.tradingAccount.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true },
  });

  if (accounts.length !== uniqueIds.length) {
    throw new HttpError(400, 'One or more trading account assignments are invalid.');
  }
}

function serializeSetupTokenResponse(args: {
  adminUserId: number;
  rawToken: string;
  expiresAt: Date;
}) {
  return {
    adminUserId: args.adminUserId,
    setupToken: args.rawToken,
    setupPath: buildSetupPath(args.rawToken),
    expiresAt: args.expiresAt,
  };
}

export interface AdminUserWithAccess {
  id: number;
  email: string;
  name: string | null;
  role: string;
  enabled: boolean;
  emailVerifiedAt: Date | null;
  invitedAt: Date | null;
  setupCompletedAt: Date | null;
  pendingSetup: boolean;
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
      invitedAt: true,
      setupCompletedAt: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { email: 'asc' },
  });

  return users.map((user) => ({
    ...user,
    pendingSetup: isPendingSetup(user),
  }));
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
      invitedAt: true,
      setupCompletedAt: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return user
    ? {
        ...user,
        pendingSetup: isPendingSetup(user),
      }
    : null;
}

export async function createAdminUserInvitation(
  invitedByAdminUserId: number,
  input: CreateAdminUserInvitationInput,
) {
  assertInvitableRole(input.role);

  const tradingAccountAccess = normalizeAccessAssignments(input.tradingAccountAccess);

  if (input.role === 'owner' && tradingAccountAccess.length > 0) {
    throw new HttpError(400, 'Owner role has implicit access to all trading accounts.');
  }

  await assertTradingAccountsExist(
    tradingAccountAccess.map((assignment) => assignment.tradingAccountId),
  );

  const existingUser = await prisma.adminUser.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  if (existingUser) {
    throw new HttpError(400, 'An admin user with this email already exists.');
  }

  const now = new Date();
  const rawToken = createRawSetupToken();
  const tokenHash = hashSetupToken(rawToken);
  const expiresAt = buildSetupTokenExpirationDate();
  const inviterId = invitedByAdminUserId > 0 ? invitedByAdminUserId : null;

  const result = await prisma.$transaction(async (tx) => {
    const adminUser = await tx.adminUser.create({
      data: {
        email: input.email,
        name: input.name ?? null,
        role: input.role,
        enabled: input.enabled,
        passwordHash: null,
        invitedAt: now,
        invitedByAdminUserId: inviterId,
        setupCompletedAt: null,
        tradingAccountAccess: {
          create: tradingAccountAccess.map((assignment) => ({
            tradingAccountId: assignment.tradingAccountId,
            role: assignment.role,
          })),
        },
        setupTokens: {
          create: {
            tokenHash,
            expiresAt,
          },
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        enabled: true,
        emailVerifiedAt: true,
        invitedAt: true,
        setupCompletedAt: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return adminUser;
  });

  await createAdminAuditEvent({
    eventType: 'admin_user_invited',
    entityType: 'admin_user',
    entityId: result.id,
    message: 'Admin user invited',
    payload: {
      invitedByAdminUserId: inviterId,
      role: result.role,
      enabled: result.enabled,
      tradingAccountAccessCount: tradingAccountAccess.length,
      setupTokenExpiresAt: expiresAt.toISOString(),
    },
  });

  return {
    adminUser: {
      ...result,
      pendingSetup: isPendingSetup(result),
    },
    setupLink: serializeSetupTokenResponse({
      adminUserId: result.id,
      rawToken,
      expiresAt,
    }),
  };
}

export async function regenerateAdminUserSetupLink(
  adminUserId: number,
  regeneratedByAdminUserId: number,
) {
  const user = await prisma.adminUser.findUnique({
    where: { id: adminUserId },
    select: {
      id: true,
      invitedAt: true,
      setupCompletedAt: true,
      passwordHash: true,
      enabled: true,
    },
  });

  if (!user) {
    throw new HttpError(404, 'Admin user not found');
  }

  if (!isPendingSetup(user) || user.passwordHash) {
    throw new HttpError(400, 'Admin user setup is already complete.');
  }

  const now = new Date();
  const rawToken = createRawSetupToken();
  const tokenHash = hashSetupToken(rawToken);
  const expiresAt = buildSetupTokenExpirationDate();

  await prisma.$transaction([
    prisma.adminUserSetupToken.updateMany({
      where: {
        adminUserId,
        usedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    }),
    prisma.adminUserSetupToken.create({
      data: {
        adminUserId,
        tokenHash,
        expiresAt,
      },
    }),
  ]);

  await createAdminAuditEvent({
    eventType: 'admin_user_setup_link_regenerated',
    entityType: 'admin_user',
    entityId: adminUserId,
    message: 'Admin user setup link regenerated',
    payload: {
      regeneratedByAdminUserId:
        regeneratedByAdminUserId > 0 ? regeneratedByAdminUserId : null,
      setupTokenExpiresAt: expiresAt.toISOString(),
    },
  });

  return serializeSetupTokenResponse({
    adminUserId,
    rawToken,
    expiresAt,
  });
}

export async function updatePendingAdminUserTradingAccountAccess(
  adminUserId: number,
  input: UpdateAdminUserTradingAccountAccessInput,
): Promise<AdminUserTradingAccountAccess[]> {
  const user = await prisma.adminUser.findUnique({
    where: { id: adminUserId },
    select: {
      role: true,
      invitedAt: true,
      setupCompletedAt: true,
    },
  });

  if (!user) {
    throw new HttpError(404, 'Admin user not found');
  }

  if (!isPendingSetup(user)) {
    throw new HttpError(400, 'Trading account access can only be replaced before setup is complete.');
  }

  const tradingAccountAccess = normalizeAccessAssignments(input.tradingAccountAccess);

  if ((user.role === 'owner' || user.role === 'admin') && tradingAccountAccess.length > 0) {
    throw new HttpError(400, 'Owner role has implicit access to all trading accounts');
  }

  await assertTradingAccountsExist(
    tradingAccountAccess.map((assignment) => assignment.tradingAccountId),
  );

  await prisma.$transaction([
    prisma.tradingAccountAccess.deleteMany({
      where: { adminUserId },
    }),
    ...tradingAccountAccess.map((assignment) =>
      prisma.tradingAccountAccess.create({
        data: {
          adminUserId,
          tradingAccountId: assignment.tradingAccountId,
          role: assignment.role,
        },
      }),
    ),
  ]);

  return getAdminUserTradingAccountAccess(adminUserId);
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

/**
 * Update an admin user's role, enabled status, and/or name.
 * Prevents removing the last owner and demoting the current user.
 */
export async function updateAdminUser(
  userId: number,
  currentAdminId: number,
  updates: {
    name?: string | null;
    role?: string;
    enabled?: boolean;
  },
): Promise<AdminUserWithAccess> {
  const user = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });

  if (!user) {
    throw new HttpError(404, 'Admin user not found');
  }

  // Validate role if provided
  if (updates.role !== undefined) {
    const validRoles = ['owner', 'account_manager', 'account_viewer'];
    if (!updates.role || !validRoles.includes(updates.role)) {
      throw new HttpError(400, `Invalid role: ${updates.role}`);
    }
  }

  // Prevent demoting self
  if (updates.role && userId === currentAdminId && updates.role !== user.role) {
    throw new HttpError(400, 'Cannot change your own role');
  }

  // Prevent removing the last owner (treat 'admin' as owner-equivalent)
  const userIsOwnerLike = user.role === 'owner' || user.role === 'admin';
  if (updates.role && updates.role !== 'owner' && userIsOwnerLike) {
    const ownerCount = await prisma.adminUser.count({
      where: { OR: [{ role: 'owner' }, { role: 'admin' }] },
    });

    if (ownerCount === 1) {
      throw new HttpError(400, 'Cannot remove the last owner');
    }
  }

  // Prevent disabling the last owner (treat 'admin' as owner-equivalent)
  if (updates.enabled === false && userIsOwnerLike) {
    const activeOwnerCount = await prisma.adminUser.count({
      where: {
        OR: [{ role: 'owner' }, { role: 'admin' }],
        enabled: true,
      },
    });

    if (activeOwnerCount === 1) {
      throw new HttpError(400, 'Cannot disable the last active owner');
    }
  }

  const updated = await prisma.adminUser.update({
    where: { id: userId },
    data: {
      ...(updates.name !== undefined && { name: updates.name }),
      ...(updates.role !== undefined && { role: updates.role }),
      ...(updates.enabled !== undefined && { enabled: updates.enabled }),
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      enabled: true,
      emailVerifiedAt: true,
      invitedAt: true,
      setupCompletedAt: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    ...updated,
    pendingSetup: isPendingSetup(updated),
  };
}

export interface UpsertTradingAccountAccessInput {
  tradingAccountId: number;
  role: string;
}

/**
 * Upsert trading account access for a user.
 * If access exists, update it. If not, create it.
 * If the input is null/undefined, delete the access record.
 */
export async function upsertTradingAccountAccess(
  userId: number,
  tradingAccountId: number,
  input: UpsertTradingAccountAccessInput | null,
): Promise<AdminUserTradingAccountAccess | null> {
  const user = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user) {
    throw new HttpError(404, 'Admin user not found');
  }

  // Owner role cannot have explicit access records
  if (user.role === 'owner' || user.role === 'admin') {
    throw new HttpError(400, 'Owner role has implicit access to all trading accounts');
  }

  const account = await prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { id: true, displayName: true },
  });

  if (!account) {
    throw new HttpError(404, 'Trading account not found');
  }

  // Delete access if input is null
  if (!input) {
    await prisma.tradingAccountAccess.deleteMany({
      where: {
        adminUserId: userId,
        tradingAccountId: tradingAccountId,
      },
    });
    return null;
  }

  // Validate role
  const validRoles = ['OWNER', 'MANAGER', 'VIEWER'];
  const normalizedRole = input.role.toUpperCase();
  if (!validRoles.includes(normalizedRole)) {
    throw new HttpError(400, `Invalid role: ${input.role}`);
  }

  const access = await prisma.tradingAccountAccess.upsert({
    where: {
      tradingAccountId_adminUserId: {
        tradingAccountId: tradingAccountId,
        adminUserId: userId,
      },
    },
    update: {
      role: normalizedRole as 'OWNER' | 'MANAGER' | 'VIEWER',
    },
    create: {
      tradingAccountId: tradingAccountId,
      adminUserId: userId,
      role: normalizedRole as 'OWNER' | 'MANAGER' | 'VIEWER',
    },
    select: {
      id: true,
      tradingAccountId: true,
      role: true,
      canView: true,
      canPauseTrading: true,
      canResumeTrading: true,
      canEditRiskSettings: true,
      canEditStrategySettings: true,
      canEditCredentials: true,
      canManageAccess: true,
    },
  });

  return {
    id: access.id,
    tradingAccountId: access.tradingAccountId,
    displayName: account.displayName,
    role: access.role,
    canView: access.canView,
    canPauseTrading: access.canPauseTrading,
    canResumeTrading: access.canResumeTrading,
    canEditRiskSettings: access.canEditRiskSettings,
    canEditStrategySettings: access.canEditStrategySettings,
    canEditCredentials: access.canEditCredentials,
    canManageAccess: access.canManageAccess,
  };
}
