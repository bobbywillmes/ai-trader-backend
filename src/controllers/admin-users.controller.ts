import type { Request, Response, NextFunction } from 'express';
import {
  listAdminUsers,
  getAdminUserById,
  getAdminUserTradingAccountAccess,
  updateAdminUser,
  upsertTradingAccountAccess,
} from '../services/admin-users.service.js';
import { HttpError } from '../errors/http-error.js';

export async function listAdminUsersController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const users = await listAdminUsers();
    res.json(users);
  } catch (error) {
    next(error);
  }
}

export async function getAdminUserController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userIdParam = req.params.id;
    const userIdStr = Array.isArray(userIdParam) ? userIdParam[0] : userIdParam;

    if (!userIdStr) {
      throw new HttpError(400, 'User ID is required');
    }

    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) {
      throw new HttpError(400, 'Invalid user ID');
    }

    const user = await getAdminUserById(userId);
    if (!user) {
      throw new HttpError(404, 'Admin user not found');
    }

    res.json(user);
  } catch (error) {
    next(error);
  }
}

export async function getAdminUserTradingAccountAccessController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userIdParam = req.params.id;
    const userIdStr = Array.isArray(userIdParam) ? userIdParam[0] : userIdParam;

    if (!userIdStr) {
      throw new HttpError(400, 'User ID is required');
    }

    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) {
      throw new HttpError(400, 'Invalid user ID');
    }

    const accesses = await getAdminUserTradingAccountAccess(userId);
    res.json(accesses);
  } catch (error) {
    next(error);
  }
}

export async function updateAdminUserController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userIdParam = req.params.id;
    const userIdStr = Array.isArray(userIdParam) ? userIdParam[0] : userIdParam;

    if (!userIdStr) {
      throw new HttpError(400, 'User ID is required');
    }

    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) {
      throw new HttpError(400, 'Invalid user ID');
    }

    const currentAdmin = res.locals.adminUser;
    if (!currentAdmin) {
      throw new HttpError(401, 'Admin authentication required');
    }

    const { name, role, enabled } = req.body;

    const updated = await updateAdminUser(userId, currentAdmin.id, {
      name,
      role,
      enabled,
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
}

export async function upsertTradingAccountAccessController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userIdParam = req.params.id;
    const userIdStr = Array.isArray(userIdParam) ? userIdParam[0] : userIdParam;

    if (!userIdStr) {
      throw new HttpError(400, 'User ID is required');
    }

    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) {
      throw new HttpError(400, 'Invalid user ID');
    }

    const accountIdParam = req.params.accountId;
    const accountIdStr = Array.isArray(accountIdParam)
      ? accountIdParam[0]
      : accountIdParam;

    if (!accountIdStr) {
      throw new HttpError(400, 'Account ID is required');
    }

    const accountId = parseInt(accountIdStr, 10);
    if (isNaN(accountId)) {
      throw new HttpError(400, 'Invalid account ID');
    }

    const access = await upsertTradingAccountAccess(
      userId,
      accountId,
      req.body || null,
    );

    res.json(access);
  } catch (error) {
    next(error);
  }
}
