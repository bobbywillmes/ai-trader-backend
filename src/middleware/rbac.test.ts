import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformRole } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

const mocks = vi.hoisted(() => ({ membershipFindUnique: vi.fn() }));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccountMembership: { findUnique: mocks.membershipFindUnique },
  },
}));

import {
  requireSystemOwnerAccess,
  requireTradingAccountAccess,
} from './rbac.js';

function context(platformRole: PlatformRole, id = 2, param = '12') {
  const next = vi.fn() as NextFunction;
  const req = { params: param === '' ? {} : { id: param } } as unknown as Request;
  const res = {
    locals: { user: { id, platformRole } },
  } as unknown as Response;
  return { next, req, res };
}

describe('trading account membership authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows system owners without a membership lookup', async () => {
    const { req, res, next } = context(PlatformRole.SYSTEM_OWNER);

    await requireTradingAccountAccess('id')(req, res, next);

    expect(res.locals.authorizedTradingAccountId).toBe(12);
    expect(mocks.membershipFindUnique).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('keeps the static admin synthetic system owner unrestricted', async () => {
    const { req, res, next } = context(PlatformRole.SYSTEM_OWNER, -1);
    res.locals.isStaticAdminKey = true;

    await requireTradingAccountAccess('id')(req, res, next);

    expect(res.locals.authorizedTradingAccountId).toBe(12);
    expect(mocks.membershipFindUnique).not.toHaveBeenCalled();
  });

  it.each([PlatformRole.OPERATOR, PlatformRole.ACCOUNT_USER])(
    'allows a %s with an assigned membership',
    async (platformRole) => {
      mocks.membershipFindUnique.mockResolvedValue({ id: 4 });
      const { req, res, next } = context(platformRole);

      await requireTradingAccountAccess('id')(req, res, next);

      expect(mocks.membershipFindUnique).toHaveBeenCalledWith({
        where: {
          tradingAccountId_userId: { tradingAccountId: 12, userId: 2 },
        },
        select: { id: true },
      });
      expect(res.locals.authorizedTradingAccountId).toBe(12);
      expect(next).toHaveBeenCalledWith();
    },
  );

  it('rejects a non-owner without a membership without considering account-holder status', async () => {
    mocks.membershipFindUnique.mockResolvedValue(null);
    const { req, res, next } = context(PlatformRole.ACCOUNT_USER);
    await requireTradingAccountAccess('id')(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(res.locals.authorizedTradingAccountId).toBeUndefined();
  });

  it.each([
    ['', 'Missing required parameter: id'],
    ['not-a-number', 'Invalid id: must be a number'],
  ])('preserves 400 validation for route parameter %j', async (param, message) => {
    const { req, res, next } = context(PlatformRole.OPERATOR, 2, param);

    await requireTradingAccountAccess('id')(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message }),
    );
    expect(mocks.membershipFindUnique).not.toHaveBeenCalled();
  });
});

describe('system owner authorization', () => {
  it('allows a system owner', () => {
    const { req, res, next } = context(PlatformRole.SYSTEM_OWNER);

    requireSystemOwnerAccess(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it.each([PlatformRole.OPERATOR, PlatformRole.ACCOUNT_USER])(
    'rejects a non-owner %s',
    (platformRole) => {
      const { req, res, next } = context(platformRole);

      expect(() => requireSystemOwnerAccess(req, res, next)).toThrow(
        expect.objectContaining({ statusCode: 403 }),
      );
      expect(next).not.toHaveBeenCalled();
    },
  );

  it('rejects an unauthenticated request', () => {
    const next = vi.fn() as NextFunction;
    const req = { params: {} } as unknown as Request;
    const res = { locals: {} } as unknown as Response;

    expect(() => requireSystemOwnerAccess(req, res, next)).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
