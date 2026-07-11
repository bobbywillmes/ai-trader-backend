import type { Request, Response, NextFunction } from 'express';
import {
  createAdminUserInvitation,
  listAdminUsers,
  getAdminUserById,
  getAdminUserTradingAccountAccess,
  regenerateAdminUserSetupLink,
  updateAdminUser,
  updatePendingAdminUserTradingAccountAccess,
  upsertTradingAccountAccess,
} from '../services/admin-users.service.js';
import { HttpError } from '../errors/http-error.js';
import {
  createAdminUserInvitationSchema,
  updateAdminUserTradingAccountAccessSchema,
} from '../validators/admin-users.schema.js';

function parseRequiredNumericParam(value: string | string[] | undefined, label: string) {
  const valueStr = Array.isArray(value) ? value[0] : value;

  if (!valueStr) {
    throw new HttpError(400, `${label} is required`);
  }

  const parsed = parseInt(valueStr, 10);
  if (isNaN(parsed)) {
    throw new HttpError(400, `Invalid ${label}`);
  }

  return parsed;
}

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

export async function createAdminUserInvitationController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const currentAdmin = res.locals.user;
    if (!currentAdmin) {
      throw new HttpError(401, 'Admin authentication required');
    }

    const input = createAdminUserInvitationSchema.parse(req.body);
    const invitation = await createAdminUserInvitation(currentAdmin.id, input);

    res.status(201).json(invitation);
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
    const userId = parseRequiredNumericParam(req.params.id, 'User ID');

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
    const userId = parseRequiredNumericParam(req.params.id, 'User ID');

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
    const userId = parseRequiredNumericParam(req.params.id, 'User ID');

    const currentAdmin = res.locals.user;
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

export async function regenerateAdminUserSetupLinkController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const currentAdmin = res.locals.user;
    if (!currentAdmin) {
      throw new HttpError(401, 'Admin authentication required');
    }

    const userId = parseRequiredNumericParam(req.params.id, 'User ID');
    const setupLink = await regenerateAdminUserSetupLink(userId, currentAdmin.id);

    res.json({ setupLink });
  } catch (error) {
    next(error);
  }
}

export async function updateAdminUserTradingAccountAccessController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = parseRequiredNumericParam(req.params.id, 'User ID');
    const input = updateAdminUserTradingAccountAccessSchema.parse(req.body);
    const accesses = await updatePendingAdminUserTradingAccountAccess(
      userId,
      input,
    );

    res.json(accesses);
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
    const userId = parseRequiredNumericParam(req.params.id, 'User ID');
    const accountId = parseRequiredNumericParam(req.params.accountId, 'Account ID');

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
