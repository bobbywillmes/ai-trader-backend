/**
 * Role-Based Access Control (RBAC) middleware helpers.
 * These utilities are designed to enforce admin permissions on routes.
 * Currently not applied to existing routes—intended for Phase 4B enforcement.
 */

import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../errors/http-error.js';
import { roleHasPermission, isOwnerRole } from '../types/admin-rbac.js';
import { prisma } from '../db/prisma.js';

/**
 * Require the authenticated admin user to have owner-level access.
 * Use this to protect owner-only operations.
 *
 * Accepts both current "owner" role and legacy "admin" role for backward compatibility.
 *
 * Prerequisites: requireAdminAccess must run first to populate res.locals.adminUser
 */
export function requireOwnerAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const adminUser = res.locals.adminUser;

  if (!adminUser) {
    throw new HttpError(401, 'Admin authentication required.');
  }

  if (!isOwnerRole(adminUser.role)) {
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
 * Prerequisites: requireAdminAccess must run first to populate res.locals.adminUser
 */
export function requirePermission(requiredPermission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const adminUser = res.locals.adminUser;

    if (!adminUser) {
      throw new HttpError(401, 'Admin authentication required.');
    }

    if (!roleHasPermission(adminUser.role, requiredPermission)) {
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
 * Prerequisites: requireAdminAccess must run first to populate res.locals.adminUser
 */
export function requireTradingAccountAccess(paramName: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const adminUser = res.locals.adminUser;

      if (!adminUser) {
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

      // Owner (including legacy "admin" role) can access any account
      if (isOwnerRole(adminUser.role)) {
        res.locals.authorizedTradingAccountId = accountId;
        next();
        return;
      }

      // Other roles: check explicit access
      const access = await prisma.tradingAccountAccess.findUnique({
        where: {
          tradingAccountId_adminUserId: {
            tradingAccountId: accountId,
            adminUserId: adminUser.id,
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
