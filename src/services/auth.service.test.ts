import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformRole } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  hash: vi.fn(),
  verify: vi.fn(),
  audit: vi.fn(),
  userCount: vi.fn(),
  userCreate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  sessionCreate: vi.fn(),
  sessionFindUnique: vi.fn(),
  sessionUpdate: vi.fn(),
  sessionUpdateMany: vi.fn(),
  setupTokenFindUnique: vi.fn(),
  setupTokenUpdateMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: {
    argon2id: 2,
    hash: mocks.hash,
    verify: mocks.verify,
  },
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    user: {
      count: mocks.userCount,
      create: mocks.userCreate,
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
    },
    userSession: {
      create: mocks.sessionCreate,
      findUnique: mocks.sessionFindUnique,
      update: mocks.sessionUpdate,
      updateMany: mocks.sessionUpdateMany,
    },
    userSetupToken: {
      findUnique: mocks.setupTokenFindUnique,
      updateMany: mocks.setupTokenUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('./admin-audit.service.js', () => ({
  createAdminAuditEvent: mocks.audit,
}));

import {
  bootstrapFirstUser,
  changePassword,
  completeSetup,
  createUserSession,
  getUserSessionFromToken,
  revokeUserSession,
  validateLogin,
  validateSetupToken,
} from './auth.service.js';

const now = new Date('2026-07-11T17:00:00.000Z');
const user = {
  id: 7,
  email: 'user@example.com',
  name: 'User',
  passwordHash: 'stored-hash',
  platformRole: PlatformRole.OPERATOR,
  enabled: true,
  invitedAt: null,
  setupCompletedAt: now,
  emailVerifiedAt: now,
  lastLoginAt: null,
  createdAt: now,
  updatedAt: now,
};

describe('auth service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hash.mockResolvedValue('new-hash');
    mocks.verify.mockResolvedValue(true);
    mocks.audit.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (input: unknown) =>
      typeof input === 'function'
        ? input({
            user: { update: mocks.userUpdate },
            userSetupToken: { updateMany: mocks.setupTokenUpdateMany },
          })
        : Promise.all(input as Promise<unknown>[]),
    );
  });

  it('bootstraps the first user as system owner and blocks later bootstrap', async () => {
    mocks.userCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    mocks.userCreate.mockResolvedValue({ ...user, platformRole: PlatformRole.SYSTEM_OWNER });

    await bootstrapFirstUser({ email: ' USER@EXAMPLE.COM ', password: 'long-password' });
    expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: 'user@example.com',
        platformRole: PlatformRole.SYSTEM_OWNER,
      }),
    }));
    await expect(
      bootstrapFirstUser({ email: 'other@example.com', password: 'long-password' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('logs in enabled users and rejects disabled users', async () => {
    mocks.userFindUnique.mockResolvedValueOnce(user).mockResolvedValueOnce({ ...user, enabled: false });
    mocks.userUpdate.mockResolvedValue(user);

    await expect(validateLogin({ email: user.email, password: 'password' })).resolves.toEqual(user);
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: user.id },
      data: { lastLoginAt: expect.any(Date) },
    });
    await expect(validateLogin({ email: user.email, password: 'password' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('creates and validates active user sessions', async () => {
    const session = { id: 3, userId: user.id, expiresAt: new Date('2099-01-01'), createdAt: now };
    mocks.sessionCreate.mockResolvedValue(session);
    mocks.sessionFindUnique.mockResolvedValue({ ...session, revokedAt: null, user });
    mocks.sessionUpdate.mockResolvedValue(session);

    const created = await createUserSession({ userId: user.id, userAgent: 'vitest' });
    expect(created.session).toBe(session);
    await expect(getUserSessionFromToken(created.rawToken)).resolves.toEqual(
      expect.objectContaining({ user }),
    );
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { lastSeenAt: expect.any(Date) },
    }));
  });

  it('returns null for revoked sessions and revokes active sessions on logout', async () => {
    mocks.sessionFindUnique
      .mockResolvedValueOnce({ id: 3, revokedAt: now, expiresAt: new Date('2099-01-01'), user })
      .mockResolvedValueOnce({ id: 3, userId: user.id, revokedAt: null });
    mocks.sessionUpdate.mockResolvedValue({ id: 3, userId: user.id, revokedAt: now });

    await expect(getUserSessionFromToken('revoked')).resolves.toBeNull();
    await expect(revokeUserSession('active')).resolves.toEqual(expect.objectContaining({ id: 3 }));
  });

  it('changes the password and revokes other sessions', async () => {
    mocks.userFindUnique.mockResolvedValue(user);
    mocks.userUpdate.mockResolvedValue(user);
    mocks.sessionUpdateMany.mockResolvedValue({ count: 2 });

    await changePassword(user.id, 3, {
      currentPassword: 'old-password',
      newPassword: 'new-long-password',
    });
    expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: user.id, id: { not: 3 }, revokedAt: null },
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'user_password_changed',
      entityType: 'user',
    }));
  });

  it('validates pending setup tokens', async () => {
    const pendingUser = { ...user, passwordHash: null, setupCompletedAt: null, invitedAt: now };
    mocks.setupTokenFindUnique.mockResolvedValue({
      id: 10,
      userId: user.id,
      user: pendingUser,
      usedAt: null,
      revokedAt: null,
      expiresAt: new Date('2099-01-01'),
    });

    await expect(validateSetupToken('setup-token')).resolves.toEqual({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        platformRole: user.platformRole,
        enabled: true,
      },
      expiresAt: new Date('2099-01-01'),
    });
  });

  it('rejects expired setup tokens', async () => {
    mocks.setupTokenFindUnique.mockResolvedValue({
      user,
      usedAt: null,
      revokedAt: null,
      expiresAt: new Date('2000-01-01'),
    });

    await expect(validateSetupToken('expired')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('completes setup once and revokes other setup tokens', async () => {
    const pendingUser = { ...user, passwordHash: null, setupCompletedAt: null, invitedAt: now };
    mocks.setupTokenFindUnique.mockResolvedValue({
      id: 10,
      userId: user.id,
      user: pendingUser,
      usedAt: null,
      revokedAt: null,
      expiresAt: new Date('2099-01-01'),
    });
    mocks.setupTokenUpdateMany.mockResolvedValue({ count: 1 });
    mocks.userUpdate.mockResolvedValue({ ...pendingUser, passwordHash: 'new-hash' });

    await expect(
      completeSetup('setup-token', {
        password: 'new-long-password',
        confirmPassword: 'new-long-password',
      }),
    ).resolves.toEqual(expect.objectContaining({
      user: expect.objectContaining({ id: user.id }),
      setupCompletedAt: expect.any(Date),
    }));
    expect(mocks.setupTokenUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'user_setup_completed',
      entityType: 'user',
    }));
  });
});
