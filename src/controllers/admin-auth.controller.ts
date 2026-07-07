import type { Request, Response, NextFunction } from 'express';
import {
  adminBootstrapSchema,
  adminLoginSchema,
  adminChangePasswordSchema,
} from '../validators/admin-auth.schema.js';
import {
  bootstrapFirstAdminUser,
  createAdminSession,
  getAdminSessionFromToken,
  revokeAdminSession,
  validateAdminLogin,
  changeAdminPassword,
  verifyAdminPassword,
} from '../services/admin-auth.service.js';
import { getAdminAccessMetadata } from '../services/admin-access.service.js';
import { HttpError } from '../errors/http-error.js';

function readBearerToken(req: Request) {
  const authHeader = req.header('authorization') ?? '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new HttpError(401, 'Admin session token required.');
  }

  return token.trim();
}

function serializeAdminUser(adminUser: {
  id: number;
  email: string;
  role: string;
  enabled: boolean;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: adminUser.id,
    email: adminUser.email,
    role: adminUser.role,
    enabled: adminUser.enabled,
    lastLoginAt: adminUser.lastLoginAt ?? null,
    createdAt: adminUser.createdAt,
    updatedAt: adminUser.updatedAt,
  };
}

export async function adminBootstrapController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = adminBootstrapSchema.parse(req.body);
    const adminUser = await bootstrapFirstAdminUser(input);

    res.status(201).json({
      ok: true,
      adminUser,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminLoginController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = adminLoginSchema.parse(req.body);
    const adminUser = await validateAdminLogin(input);

    const { rawToken, session } = await createAdminSession({
      adminUserId: adminUser.id,
      userAgent: req.get('user-agent') ?? null,
      ipAddress: req.ip ?? null,
    });

    const accessMetadata = await getAdminAccessMetadata(adminUser.id);

    res.status(200).json({
      ok: true,
      token: rawToken,
      tokenType: 'Bearer',
      adminUser: serializeAdminUser(adminUser),
      access: accessMetadata,
      session,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminMeController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = readBearerToken(req);
    const session = await getAdminSessionFromToken(token);

    if (!session) {
      throw new HttpError(401, 'Invalid or expired admin session.');
    }

    const accessMetadata = await getAdminAccessMetadata(session.adminUser.id);

    res.status(200).json({
      ok: true,
      adminUser: serializeAdminUser(session.adminUser),
      access: accessMetadata,
      session: {
        id: session.id,
        adminUserId: session.adminUserId,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        createdAt: session.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function adminLogoutController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = readBearerToken(req);
    const revokedSession = await revokeAdminSession(token);

    res.status(200).json({
      ok: true,
      revoked: Boolean(revokedSession),
      session: revokedSession,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminVerifyPasswordController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const adminUser = res.locals.adminUser;

    if (!adminUser) {
      throw new HttpError(401, 'Admin session required.');
    }

    const password = req.body.password;
    if (!password || typeof password !== 'string') {
      throw new HttpError(400, 'Password is required.');
    }

    if (!adminUser.passwordHash) {
      throw new HttpError(400, 'Admin password setup is not complete.');
    }

    const passwordIsValid = await verifyAdminPassword(password, adminUser.passwordHash);

    if (!passwordIsValid) {
      throw new HttpError(401, 'Current password is incorrect.');
    }

    res.status(200).json({
      ok: true,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminChangePasswordController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = adminChangePasswordSchema.parse(req.body);
    const adminUser = res.locals.adminUser;
    const adminSession = res.locals.adminSession;

    if (!adminUser || !adminSession) {
      throw new HttpError(401, 'Admin session required.');
    }

    await changeAdminPassword(adminUser.id, adminSession.id, input);

    res.status(200).json({
      ok: true,
    });
  } catch (error) {
    next(error);
  }
}
