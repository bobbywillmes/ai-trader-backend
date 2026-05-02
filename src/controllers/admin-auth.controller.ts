import type { Request, Response, NextFunction } from 'express';
import {
  adminBootstrapSchema,
  adminLoginSchema,
} from '../validators/admin-auth.schema.js';
import {
  bootstrapFirstAdminUser,
  createAdminSession,
  getAdminSessionFromToken,
  revokeAdminSession,
  validateAdminLogin,
} from '../services/admin-auth.service.js';
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

    res.status(200).json({
      ok: true,
      token: rawToken,
      tokenType: 'Bearer',
      adminUser: serializeAdminUser(adminUser),
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

    res.status(200).json({
      ok: true,
      adminUser: serializeAdminUser(session.adminUser),
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