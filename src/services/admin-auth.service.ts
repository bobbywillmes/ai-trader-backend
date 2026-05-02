import argon2 from 'argon2';
import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type {
  AdminBootstrapInput,
  AdminLoginInput,
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
      role: 'admin',
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

  if (!adminUser || !adminUser.enabled) {
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