/**
 * Role-Based Access Control (RBAC) middleware helpers.
 * These utilities are designed to enforce admin permissions on routes.
 * Currently not applied to existing routes—intended for Phase 4B enforcement.
 */

import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../errors/http-error.js';
import { platformRoleHasPermission, isSystemOwnerRole } from '../types/platform-rbac.js';
import { prisma } from '../db/prisma.js';

/**
 * Require the authenticated user to have owner-level access.
 * Use this to protect owner-only operations.
 *
 * Prerequisites: requireAdminAccess must run first to populate res.locals.user
 */
export function requireOwnerAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const user = res.locals.user;

  if (!user) {
    throw new HttpError(401, 'Admin authentication required.');
  }

  if (!isSystemOwnerRole(user.platformRole)) {
    throw new HttpError(403, 'Owner access required.');
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
export function requirePermission(requiredPermission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user;

    if (!user) {
      throw new HttpError(401, 'Admin authentication required.');
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
 * Owner role can access any account; other roles must have explicit TradingAccountAccess.
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
        throw new HttpError(401, 'Admin authentication required.');
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

      // Other roles: check explicit access
      const access = await prisma.tradingAccountAccess.findUnique({
        where: {
          tradingAccountId_adminUserId: {
            tradingAccountId: accountId,
            adminUserId: user.id,
          },
        },
        select: { id: true },
      });

      if (!access) {
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
