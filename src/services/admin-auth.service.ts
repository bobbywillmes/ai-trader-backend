import argon2 from 'argon2';
import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { createAdminAuditEvent } from './admin-audit.service.js';
import { AdminRole } from '../types/admin-rbac.js';
import type {
  AdminBootstrapInput,
  AdminLoginInput,
  AdminChangePasswordInput,
  AdminSetupPasswordInput,
} from '../validators/admin-auth.schema.js';

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

export async function hashAdminPassword(password: string) {
  return argon2.hash(password, {
    type: argon2.argon2id,
  });
}

export async function verifyAdminPassword(password: string, passwordHash: string) {
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

function isPendingAdminSetup(adminUser: {
  invitedAt: Date | null;
  setupCompletedAt: Date | null;
  passwordHash: string | null;
}) {
  return Boolean(
    adminUser.invitedAt && !adminUser.setupCompletedAt && !adminUser.passwordHash,
  );
}

function serializeSetupTokenAdminUser(adminUser: {
  id: number;
  email: string;
  name: string | null;
  role: string;
  enabled: boolean;
}) {
  return {
    id: adminUser.id,
    email: adminUser.email,
    name: adminUser.name,
    role: adminUser.role,
    enabled: adminUser.enabled,
  };
}

export async function getAdminUserCount() {
  return prisma.adminUser.count();
}

export async function bootstrapFirstAdminUser(input: AdminBootstrapInput) {
  const existingAdminCount = await getAdminUserCount();

  if (existingAdminCount > 0) {
    throw new HttpError(409, 'Admin bootstrap is already complete.');
  }

  const email = normalizeEmail(input.email);
  const passwordHash = await hashAdminPassword(input.password);

  return prisma.adminUser.create({
    data: {
      email,
      passwordHash,
      role: AdminRole.OWNER,
      enabled: true,
    },
    select: {
      id: true,
      email: true,
      role: true,
      enabled: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function validateAdminLogin(input: AdminLoginInput) {
  const email = normalizeEmail(input.email);

  const adminUser = await prisma.adminUser.findUnique({
    where: { email },
  });

  if (!adminUser || !adminUser.enabled || !adminUser.passwordHash) {
    throw new HttpError(401, 'Invalid admin login.');
  }

  const passwordIsValid = await verifyAdminPassword(
    input.password,
    adminUser.passwordHash,
  );

  if (!passwordIsValid) {
    throw new HttpError(401, 'Invalid admin login.');
  }

  await prisma.adminUser.update({
    where: { id: adminUser.id },
    data: {
      lastLoginAt: new Date(),
    },
  });

  return adminUser;
}

export async function createAdminSession(args: {
  adminUserId: number;
  userAgent?: string | null;
  ipAddress?: string | null;
}) {
  const rawToken = createRawSessionToken();
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = buildSessionExpirationDate();

  const session = await prisma.adminSession.create({
    data: {
      adminUserId: args.adminUserId,
      tokenHash,
      userAgent: args.userAgent ?? null,
      ipAddress: args.ipAddress ?? null,
      expiresAt,
    },
    select: {
      id: true,
      adminUserId: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  return {
    rawToken,
    session,
  };
}

export async function getAdminSessionFromToken(rawToken: string) {
  const tokenHash = hashSessionToken(rawToken);

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash },
    include: {
      adminUser: true,
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

  if (!session.adminUser.enabled) {
    return null;
  }

  await prisma.adminSession.update({
    where: { id: session.id },
    data: {
      lastSeenAt: new Date(),
    },
  });

  return session;
}

export async function revokeAdminSession(rawToken: string) {
  const tokenHash = hashSessionToken(rawToken);

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash },
  });

  if (!session || session.revokedAt) {
    return null;
  }

  return prisma.adminSession.update({
    where: { id: session.id },
    data: {
      revokedAt: new Date(),
    },
    select: {
      id: true,
      adminUserId: true,
      revokedAt: true,
    },
  });
}

export async function changeAdminPassword(
  adminUserId: number,
  currentSessionId: number,
  input: AdminChangePasswordInput,
) {
  const adminUser = await prisma.adminUser.findUnique({
    where: { id: adminUserId },
  });

  if (!adminUser) {
    throw new HttpError(404, 'Admin user not found.');
  }

  if (!adminUser.passwordHash) {
    throw new HttpError(400, 'Admin password setup is not complete.');
  }

  const passwordIsValid = await verifyAdminPassword(
    input.currentPassword,
    adminUser.passwordHash,
  );

  if (!passwordIsValid) {
    throw new HttpError(401, 'Current password is incorrect.');
  }

  const newPasswordHash = await hashAdminPassword(input.newPassword);

  await prisma.$transaction([
    prisma.adminUser.update({
      where: { id: adminUserId },
      data: { passwordHash: newPasswordHash },
    }),
    prisma.adminSession.updateMany({
      where: {
        adminUserId,
        id: { not: currentSessionId },
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }),
  ]);

  await createAdminAuditEvent({
    eventType: 'admin_password_changed',
    entityType: 'admin_user',
    entityId: adminUserId,
    message: 'Admin password changed',
    payload: { currentSessionId },
  });
}

export async function validateAdminSetupToken(rawToken: string) {
  const tokenHash = hashSetupToken(rawToken);

  const setupToken = await prisma.adminUserSetupToken.findUnique({
    where: { tokenHash },
    include: {
      adminUser: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
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
    !setupToken.adminUser.enabled ||
    !isPendingAdminSetup(setupToken.adminUser)
  ) {
    throw new HttpError(400, 'Invalid or expired setup token.');
  }

  return {
    adminUser: serializeSetupTokenAdminUser(setupToken.adminUser),
    expiresAt: setupToken.expiresAt,
  };
}

export async function completeAdminSetup(
  rawToken: string,
  input: AdminSetupPasswordInput,
) {
  const tokenHash = hashSetupToken(rawToken);

  const setupToken = await prisma.adminUserSetupToken.findUnique({
    where: { tokenHash },
    include: {
      adminUser: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
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
    !setupToken.adminUser.enabled ||
    !isPendingAdminSetup(setupToken.adminUser)
  ) {
    throw new HttpError(400, 'Invalid or expired setup token.');
  }

  const passwordHash = await hashAdminPassword(input.password);
  const completedAt = new Date();

  const updatedUser = await prisma.$transaction(async (tx) => {
    const claimedToken = await tx.adminUserSetupToken.updateMany({
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

    await tx.adminUserSetupToken.updateMany({
      where: {
        adminUserId: setupToken.adminUserId,
        id: { not: setupToken.id },
        usedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: completedAt },
    });

    return tx.adminUser.update({
      where: {
        id: setupToken.adminUserId,
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
        role: true,
        enabled: true,
      },
    });
  });

  await createAdminAuditEvent({
    eventType: 'admin_user_setup_completed',
    entityType: 'admin_user',
    entityId: updatedUser.id,
    message: 'Admin user setup completed',
    payload: {
      setupTokenId: setupToken.id,
    },
  });

  return {
    adminUser: serializeSetupTokenAdminUser(updatedUser),
    setupCompletedAt: completedAt,
  };
}
