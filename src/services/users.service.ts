import crypto from 'node:crypto';
import { PlatformRole } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { createAdminAuditEvent } from './admin-audit.service.js';
import type {
  CreateUserInvitationInput,
  ReplaceUserTradingAccountMembershipsInput,
  UpdateUserInput,
} from '../validators/users.schema.js';

const SETUP_TOKEN_BYTES = 32;
const SETUP_TOKEN_TTL_DAYS = 7;

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  platformRole: true,
  enabled: true,
  emailVerifiedAt: true,
  invitedAt: true,
  setupCompletedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MEMBERSHIP_SELECT = {
  id: true,
  tradingAccountId: true,
  createdAt: true,
  updatedAt: true,
  tradingAccount: { select: { displayName: true } },
} as const;

function createRawSetupToken() {
  return crypto.randomBytes(SETUP_TOKEN_BYTES).toString('base64url');
}

function hashSetupToken(rawToken: string) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function buildSetupTokenExpirationDate() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SETUP_TOKEN_TTL_DAYS);
  return expiresAt;
}

function buildSetupPath(rawToken: string) {
  return `/setup-account?token=${encodeURIComponent(rawToken)}`;
}

function isPendingSetup(user: { invitedAt: Date | null; setupCompletedAt: Date | null }) {
  return Boolean(user.invitedAt && !user.setupCompletedAt);
}

function serializeUser<T extends { invitedAt: Date | null; setupCompletedAt: Date | null }>(
  user: T,
) {
  return { ...user, pendingSetup: isPendingSetup(user) };
}

function serializeMembership(membership: {
  id: number;
  tradingAccountId: number;
  createdAt: Date;
  updatedAt: Date;
  tradingAccount: { displayName: string };
}) {
  return {
    id: membership.id,
    tradingAccountId: membership.tradingAccountId,
    displayName: membership.tradingAccount.displayName,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt,
  };
}

function uniqueIds(ids: number[]) {
  return [...new Set(ids)];
}

async function assertTradingAccountsExist(tradingAccountIds: number[]) {
  if (tradingAccountIds.length === 0) return;

  const accounts = await prisma.tradingAccount.findMany({
    where: { id: { in: tradingAccountIds } },
    select: { id: true },
  });

  if (accounts.length !== tradingAccountIds.length) {
    throw new HttpError(400, 'One or more Trading Account IDs are invalid.');
  }
}

function setupLink(userId: number, rawToken: string, expiresAt: Date) {
  return {
    userId,
    setupToken: rawToken,
    setupPath: buildSetupPath(rawToken),
    expiresAt,
  };
}

export async function listUsers() {
  const users = await prisma.user.findMany({
    select: USER_SELECT,
    orderBy: { email: 'asc' },
  });
  return users.map(serializeUser);
}

export async function getUserById(id: number) {
  const user = await prisma.user.findUnique({ where: { id }, select: USER_SELECT });
  return user ? serializeUser(user) : null;
}

export async function createUserInvitation(
  invitedByUserId: number,
  input: CreateUserInvitationInput,
) {
  const tradingAccountIds = uniqueIds(input.tradingAccountIds);
  await assertTradingAccountsExist(tradingAccountIds);

  const existingUser = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existingUser) {
    throw new HttpError(400, 'A user with this email already exists.');
  }

  const now = new Date();
  const rawToken = createRawSetupToken();
  const tokenHash = hashSetupToken(rawToken);
  const expiresAt = buildSetupTokenExpirationDate();
  const inviterId = invitedByUserId > 0 ? invitedByUserId : null;

  const user = await prisma.$transaction((tx) =>
    tx.user.create({
      data: {
        email: input.email,
        name: input.name ?? null,
        platformRole: input.platformRole,
        enabled: input.enabled,
        passwordHash: null,
        invitedAt: now,
        invitedByUserId: inviterId,
        setupCompletedAt: null,
        tradingAccountMemberships: {
          create: tradingAccountIds.map((tradingAccountId) => ({ tradingAccountId })),
        },
        setupTokens: { create: { tokenHash, expiresAt } },
      },
      select: USER_SELECT,
    }),
  );

  await createAdminAuditEvent({
    eventType: 'user_invited',
    entityType: 'user',
    entityId: user.id,
    message: 'User invited',
    payload: {
      invitedByUserId: inviterId,
      platformRole: user.platformRole,
      enabled: user.enabled,
      tradingAccountIds,
      membershipCount: tradingAccountIds.length,
      setupTokenExpiresAt: expiresAt.toISOString(),
    },
  });

  return {
    user: serializeUser(user),
    setupLink: setupLink(user.id, rawToken, expiresAt),
  };
}

export async function regenerateUserSetupLink(
  userId: number,
  regeneratedByUserId: number,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, invitedAt: true, setupCompletedAt: true, passwordHash: true },
  });
  if (!user) throw new HttpError(404, 'User not found.');
  if (!isPendingSetup(user) || user.passwordHash) {
    throw new HttpError(400, 'User setup is already complete.');
  }

  const now = new Date();
  const rawToken = createRawSetupToken();
  const expiresAt = buildSetupTokenExpirationDate();
  await prisma.$transaction([
    prisma.userSetupToken.updateMany({
      where: { userId, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.userSetupToken.create({
      data: { userId, tokenHash: hashSetupToken(rawToken), expiresAt },
    }),
  ]);

  await createAdminAuditEvent({
    eventType: 'user_setup_link_regenerated',
    entityType: 'user',
    entityId: userId,
    message: 'User setup link regenerated',
    payload: {
      regeneratedByUserId: regeneratedByUserId > 0 ? regeneratedByUserId : null,
      setupTokenExpiresAt: expiresAt.toISOString(),
    },
  });

  return setupLink(userId, rawToken, expiresAt);
}

export async function getUserTradingAccountMemberships(userId: number) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new HttpError(404, 'User not found.');

  const memberships = await prisma.tradingAccountMembership.findMany({
    where: { userId },
    select: MEMBERSHIP_SELECT,
    orderBy: { tradingAccount: { displayName: 'asc' } },
  });
  return memberships.map(serializeMembership);
}

export async function replaceUserTradingAccountMemberships(
  userId: number,
  input: ReplaceUserTradingAccountMembershipsInput,
) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new HttpError(404, 'User not found.');

  const requestedIds = uniqueIds(input.tradingAccountIds);
  await assertTradingAccountsExist(requestedIds);

  const holderAccounts = await prisma.tradingAccount.findMany({
    where: { accountHolderUserId: userId },
    select: { id: true },
  });
  const requested = new Set(requestedIds);
  if (holderAccounts.some((account) => !requested.has(account.id))) {
    throw new HttpError(
      400,
      "Cannot remove a Trading Account membership while the user is that account's account holder.",
    );
  }

  const existing = await prisma.tradingAccountMembership.findMany({
    where: { userId },
    select: { id: true, tradingAccountId: true },
  });
  const existingIds = new Set(existing.map((membership) => membership.tradingAccountId));
  const removeIds = existing
    .filter((membership) => !requested.has(membership.tradingAccountId))
    .map((membership) => membership.id);
  const createIds = requestedIds.filter((id) => !existingIds.has(id));

  await prisma.$transaction([
    prisma.tradingAccountMembership.deleteMany({ where: { id: { in: removeIds } } }),
    ...createIds.map((tradingAccountId) =>
      prisma.tradingAccountMembership.create({ data: { userId, tradingAccountId } }),
    ),
  ]);

  const memberships = await getUserTradingAccountMemberships(userId);
  await createAdminAuditEvent({
    eventType: 'user_memberships_updated',
    entityType: 'user',
    entityId: userId,
    message: 'User Trading Account memberships updated',
    payload: { tradingAccountIds: requestedIds, membershipCount: memberships.length },
  });
  return memberships;
}

export async function updateUser(
  userId: number,
  currentUserId: number,
  updates: UpdateUserInput,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, platformRole: true },
  });
  if (!user) throw new HttpError(404, 'User not found.');

  if (
    updates.platformRole !== undefined &&
    userId === currentUserId &&
    updates.platformRole !== user.platformRole
  ) {
    throw new HttpError(400, 'Cannot change your own platform role.');
  }

  if (
    user.platformRole === PlatformRole.SYSTEM_OWNER &&
    updates.platformRole !== undefined &&
    updates.platformRole !== PlatformRole.SYSTEM_OWNER
  ) {
    const ownerCount = await prisma.user.count({
      where: { platformRole: PlatformRole.SYSTEM_OWNER },
    });
    if (ownerCount === 1) throw new HttpError(400, 'Cannot demote the final system owner.');
  }

  if (user.platformRole === PlatformRole.SYSTEM_OWNER && updates.enabled === false) {
    const enabledOwnerCount = await prisma.user.count({
      where: { platformRole: PlatformRole.SYSTEM_OWNER, enabled: true },
    });
    if (enabledOwnerCount === 1) {
      throw new HttpError(400, 'Cannot disable the final enabled system owner.');
    }
  }

  const changedFields = Object.keys(updates);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.platformRole !== undefined
        ? { platformRole: updates.platformRole }
        : {}),
      ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
    },
    select: USER_SELECT,
  });

  await createAdminAuditEvent({
    eventType: 'user_updated',
    entityType: 'user',
    entityId: userId,
    message: 'User updated',
    payload: {
      changedFields,
      platformRole: updated.platformRole,
      updatedByUserId: currentUserId > 0 ? currentUserId : null,
    },
  });
  return serializeUser(updated);
}
