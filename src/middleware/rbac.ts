/**
 * Role-Based Access Control (RBAC) middleware helpers.
 * These utilities are designed to enforce admin permissions on routes.
 * Currently not applied to existing routes—intended for Phase 4B enforcement.
 */

import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../errors/http-error.js';
import {
  platformRoleHasPermission,
  isSystemOwnerRole,
  type PlatformPermission,
} from '../types/platform-rbac.js';
import { prisma } from '../db/prisma.js';

/**
 * Require the authenticated user to have owner-level access.
 * Use this to protect owner-only operations.
 *
 * Prerequisites: requireAdminAccess must run first to populate res.locals.user
 */
export function requireSystemOwnerAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const user = res.locals.user;

  if (!user) {
    throw new HttpError(401, 'Authentication required.');
  }

  if (!isSystemOwnerRole(user.platformRole)) {
    throw new HttpError(403, 'System owner access required.');
  }

  next();
}

/**
 * Factory to create middleware that requires a specific permission.
 * Use this to protect operations that require specific capabilities.
 *
 * Example: router.get('/admin-settings', requirePermission('system.settings.read'), handler)
 *
 * Prerequisites: requireAdminAccess must run first to populate res.locals.user
 */
export function requirePermission(requiredPermission: PlatformPermission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user;

    if (!user) {
      throw new HttpError(401, 'Authentication required.');
    }

    if (!platformRoleHasPermission(user.platformRole, requiredPermission)) {
      throw new HttpError(
        403,
        `Permission required: ${requiredPermission}`,
      );
    }

    next();
  };
}

/**
 * Factory to create middleware that requires access to a specific trading account.
 * System owners can access any account; other users need a membership.
 *
 * Checks a route parameter (e.g., 'tradingAccountId') and verifies the user has access.
 * Sets res.locals.authorizedTradingAccountId on success.
 *
 * Example: router.get(
 *   '/trading-accounts/:tradingAccountId/settings',
 *   requireTradingAccountAccess('tradingAccountId'),
 *   handler
 * )
 *
 * Prerequisites: requireAdminAccess must run first to populate res.locals.user
 */
export function requireTradingAccountAccess(paramName: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = res.locals.user;

      if (!user) {
        throw new HttpError(401, 'Authentication required.');
      }

      const accountIdParam = req.params[paramName];
      const accountIdStr = Array.isArray(accountIdParam)
        ? accountIdParam[0]
        : accountIdParam;

      if (!accountIdStr) {
        throw new HttpError(400, `Missing required parameter: ${paramName}`);
      }

      const accountId = parseInt(accountIdStr, 10);
      if (isNaN(accountId)) {
        throw new HttpError(400, `Invalid ${paramName}: must be a number`);
      }

      // System owners can access any account.
      if (isSystemOwnerRole(user.platformRole)) {
        res.locals.authorizedTradingAccountId = accountId;
        next();
        return;
      }

      const membership = await prisma.tradingAccountMembership.findUnique({
        where: {
          tradingAccountId_userId: {
            tradingAccountId: accountId,
            userId: user.id,
          },
        },
        select: { id: true },
      });

      if (!membership) {
        throw new HttpError(
          403,
          'Access to this trading account is not permitted.',
        );
      }

      res.locals.authorizedTradingAccountId = accountId;
      next();
    } catch (error) {
      next(error);
    }
  };
}
