import argon2 from 'argon2';
import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { createAdminAuditEvent } from './admin-audit.service.js';
import { PlatformRole } from '../types/platform-rbac.js';
import type {
  BootstrapInput,
  LoginInput,
  ChangePasswordInput,
  SetupPasswordInput,
} from '../validators/auth.schema.js';

const SESSION_TOKEN_BYTES = 32;
const SESSION_TTL_DAYS = 7;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function buildSessionExpirationDate() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);
  return expiresAt;
}

export async function hashPassword(password: string) {
  return argon2.hash(password, {
    type: argon2.argon2id,
  });
}

export async function verifyPassword(password: string, passwordHash: string) {
  return argon2.verify(passwordHash, password);
}

export function createRawSessionToken() {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(rawToken: string) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function hashSetupToken(rawToken: string) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function isPendingUserSetup(user: {
  invitedAt: Date | null;
  setupCompletedAt: Date | null;
  passwordHash: string | null;
}) {
  return Boolean(
    user.invitedAt && !user.setupCompletedAt && !user.passwordHash,
  );
}

function serializeSetupTokenUser(user: {
  id: number;
  email: string;
  name: string | null;
  platformRole: string;
  enabled: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    platformRole: user.platformRole,
    enabled: user.enabled,
  };
}

export async function getUserCount() {
  return prisma.user.count();
}

export async function bootstrapFirstUser(input: BootstrapInput) {
  const existingUserCount = await getUserCount();

  if (existingUserCount > 0) {
    throw new HttpError(409, 'User bootstrap is already complete.');
  }

  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);

  return prisma.user.create({
    data: {
      email,
      passwordHash,
      platformRole: PlatformRole.SYSTEM_OWNER,
      enabled: true,
    },
    select: {
      id: true,
      email: true,
      name: true,
      platformRole: true,
      enabled: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function validateLogin(input: LoginInput) {
  const email = normalizeEmail(input.email);

  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user || !user.enabled || !user.passwordHash) {
    throw new HttpError(401, 'Invalid login.');
  }

  const passwordIsValid = await verifyPassword(
    input.password,
    user.passwordHash,
  );

  if (!passwordIsValid) {
    throw new HttpError(401, 'Invalid login.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: new Date(),
    },
  });

  return user;
}

export async function createUserSession(args: {
  userId: number;
  userAgent?: string | null;
  ipAddress?: string | null;
}) {
  const rawToken = createRawSessionToken();
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = buildSessionExpirationDate();

  const session = await prisma.userSession.create({
    data: {
      userId: args.userId,
      tokenHash,
      userAgent: args.userAgent ?? null,
      ipAddress: args.ipAddress ?? null,
      expiresAt,
    },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  return {
    rawToken,
    session,
  };
}

export async function getUserSessionFromToken(rawToken: string) {
  const tokenHash = hashSessionToken(rawToken);

  const session = await prisma.userSession.findUnique({
    where: { tokenHash },
    include: {
      user: true,
    },
  });

  if (!session) {
    return null;
  }

  if (session.revokedAt) {
    return null;
  }

  if (session.expiresAt <= new Date()) {
    return null;
  }

  if (!session.user.enabled) {
    return null;
  }

  await prisma.userSession.update({
    where: { id: session.id },
    data: {
      lastSeenAt: new Date(),
    },
  });

  return session;
}

export async function revokeUserSession(rawToken: string) {
  const tokenHash = hashSessionToken(rawToken);

  const session = await prisma.userSession.findUnique({
    where: { tokenHash },
  });

  if (!session || session.revokedAt) {
    return null;
  }

  return prisma.userSession.update({
    where: { id: session.id },
    data: {
      revokedAt: new Date(),
    },
    select: {
      id: true,
      userId: true,
      revokedAt: true,
    },
  });
}

export async function changePassword(
  userId: number,
  currentSessionId: number,
  input: ChangePasswordInput,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new HttpError(404, 'User not found.');
  }

  if (!user.passwordHash) {
    throw new HttpError(400, 'Password setup is not complete.');
  }

  const passwordIsValid = await verifyPassword(
    input.currentPassword,
    user.passwordHash,
  );

  if (!passwordIsValid) {
    throw new HttpError(401, 'Current password is incorrect.');
  }

  const newPasswordHash = await hashPassword(input.newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    }),
    prisma.userSession.updateMany({
      where: {
        userId,
        id: { not: currentSessionId },
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }),
  ]);

  await createAdminAuditEvent({
    eventType: 'user_password_changed',
    entityType: 'user',
    entityId: userId,
    message: 'User password changed',
    payload: { currentSessionId },
  });
}

export async function validateSetupToken(rawToken: string) {
  const tokenHash = hashSetupToken(rawToken);

  const setupToken = await prisma.userSetupToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          platformRole: true,
          enabled: true,
          invitedAt: true,
          setupCompletedAt: true,
          passwordHash: true,
        },
      },
    },
  });

  if (
    !setupToken ||
    setupToken.usedAt ||
    setupToken.revokedAt ||
    setupToken.expiresAt <= new Date() ||
    !setupToken.user.enabled ||
    !isPendingUserSetup(setupToken.user)
  ) {
    throw new HttpError(400, 'Invalid or expired setup token.');
  }

  return {
    user: serializeSetupTokenUser(setupToken.user),
    expiresAt: setupToken.expiresAt,
  };
}

export async function completeSetup(
  rawToken: string,
  input: SetupPasswordInput,
) {
  const tokenHash = hashSetupToken(rawToken);

  const setupToken = await prisma.userSetupToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          platformRole: true,
          enabled: true,
          invitedAt: true,
          setupCompletedAt: true,
          passwordHash: true,
        },
      },
    },
  });

  if (
    !setupToken ||
    setupToken.usedAt ||
    setupToken.revokedAt ||
    setupToken.expiresAt <= new Date() ||
    !setupToken.user.enabled ||
    !isPendingUserSetup(setupToken.user)
  ) {
    throw new HttpError(400, 'Invalid or expired setup token.');
  }

  const passwordHash = await hashPassword(input.password);
  const completedAt = new Date();

  const updatedUser = await prisma.$transaction(async (tx) => {
    const claimedToken = await tx.userSetupToken.updateMany({
      where: {
        id: setupToken.id,
        usedAt: null,
        revokedAt: null,
      },
      data: { usedAt: completedAt },
    });

    if (claimedToken.count !== 1) {
      throw new HttpError(400, 'Invalid or expired setup token.');
    }

    await tx.userSetupToken.updateMany({
      where: {
        userId: setupToken.userId,
        id: { not: setupToken.id },
        usedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: completedAt },
    });

    return tx.user.update({
      where: {
        id: setupToken.userId,
        setupCompletedAt: null,
        passwordHash: null,
      },
      data: {
        passwordHash,
        setupCompletedAt: completedAt,
        emailVerifiedAt: completedAt,
      },
      select: {
        id: true,
        email: true,
        name: true,
        platformRole: true,
        enabled: true,
      },
    });
  });

  await createAdminAuditEvent({
    eventType: 'user_setup_completed',
    entityType: 'user',
    entityId: updatedUser.id,
    message: 'User setup completed',
    payload: {
      setupTokenId: setupToken.id,
    },
  });

  return {
    user: serializeSetupTokenUser(updatedUser),
    setupCompletedAt: completedAt,
  };
}
