import type { NextFunction, Request, Response } from 'express';

import { HttpError } from '../errors/http-error.js';
import {
  createUserInvitation,
  getUserById,
  getUserTradingAccountMemberships,
  listUsers,
  regenerateUserSetupLink,
  replaceUserTradingAccountMemberships,
  updateUser,
} from '../services/users.service.js';
import {
  createUserInvitationSchema,
  replaceUserTradingAccountMembershipsSchema,
  updateUserSchema,
} from '../validators/users.schema.js';

function userIdParam(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = raw ? Number(raw) : NaN;
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid User ID.');
  return id;
}

function authenticatedUser(res: Response) {
  if (!res.locals.user) throw new HttpError(401, 'Authentication required.');
  return res.locals.user;
}

export async function listUsersController(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await listUsers());
  } catch (error) {
    next(error);
  }
}

export async function createUserInvitationController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const currentUser = authenticatedUser(res);
    const input = createUserInvitationSchema.parse(req.body);
    res.status(201).json(await createUserInvitation(currentUser.id, input));
  } catch (error) {
    next(error);
  }
}

export async function getUserController(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await getUserById(userIdParam(req.params.id));
    if (!user) throw new HttpError(404, 'User not found.');
    res.json(user);
  } catch (error) {
    next(error);
  }
}

export async function updateUserController(req: Request, res: Response, next: NextFunction) {
  try {
    const currentUser = authenticatedUser(res);
    const input = updateUserSchema.parse(req.body);
    res.json(await updateUser(userIdParam(req.params.id), currentUser.id, input));
  } catch (error) {
    next(error);
  }
}

export async function regenerateUserSetupLinkController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const currentUser = authenticatedUser(res);
    const setupLink = await regenerateUserSetupLink(
      userIdParam(req.params.id),
      currentUser.id,
    );
    res.json({ setupLink });
  } catch (error) {
    next(error);
  }
}

export async function listUserTradingAccountMembershipsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.json(await getUserTradingAccountMemberships(userIdParam(req.params.id)));
  } catch (error) {
    next(error);
  }
}

export async function replaceUserTradingAccountMembershipsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = replaceUserTradingAccountMembershipsSchema.parse(req.body);
    res.json(
      await replaceUserTradingAccountMemberships(userIdParam(req.params.id), input),
    );
  } catch (error) {
    next(error);
  }
}
