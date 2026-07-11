import type { Request, Response, NextFunction } from 'express';
import {
  bootstrapSchema,
  loginSchema,
  changePasswordSchema,
  setupPasswordSchema,
} from '../validators/auth.schema.js';
import {
  bootstrapFirstUser,
  createUserSession,
  getUserSessionFromToken,
  revokeUserSession,
  validateLogin,
  changePassword,
  completeSetup,
  validateSetupToken,
  verifyPassword,
} from '../services/auth.service.js';
import { getAdminAccessMetadata } from '../services/admin-access.service.js';
import { HttpError } from '../errors/http-error.js';

function readBearerToken(req: Request) {
  const authHeader = req.header('authorization') ?? '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new HttpError(401, 'Session token required.');
  }

  return token.trim();
}

function readSetupTokenParam(req: Request) {
  const tokenParam = req.params.token;
  const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;

  if (!token) {
    throw new HttpError(400, 'Setup token is required.');
  }

  return token;
}

function serializeUser(user: {
  id: number;
  email: string;
  name: string | null;
  platformRole: string;
  enabled: boolean;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    platformRole: user.platformRole,
    enabled: user.enabled,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function bootstrapController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = bootstrapSchema.parse(req.body);
    const user = await bootstrapFirstUser(input);

    res.status(201).json({
      ok: true,
      user,
    });
  } catch (error) {
    next(error);
  }
}

export async function loginController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = loginSchema.parse(req.body);
    const user = await validateLogin(input);

    const { rawToken, session } = await createUserSession({
      userId: user.id,
      userAgent: req.get('user-agent') ?? null,
      ipAddress: req.ip ?? null,
    });

    const accessMetadata = await getAdminAccessMetadata(user.id);

    res.status(200).json({
      ok: true,
      token: rawToken,
      tokenType: 'Bearer',
      user: serializeUser(user),
      access: accessMetadata,
      session,
    });
  } catch (error) {
    next(error);
  }
}

export async function meController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = readBearerToken(req);
    const session = await getUserSessionFromToken(token);

    if (!session) {
      throw new HttpError(401, 'Invalid or expired session.');
    }

    const accessMetadata = await getAdminAccessMetadata(session.user.id);

    res.status(200).json({
      ok: true,
      user: serializeUser(session.user),
      access: accessMetadata,
      session: {
        id: session.id,
        userId: session.userId,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        createdAt: session.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function logoutController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = readBearerToken(req);
    const revokedSession = await revokeUserSession(token);

    res.status(200).json({
      ok: true,
      revoked: Boolean(revokedSession),
      session: revokedSession,
    });
  } catch (error) {
    next(error);
  }
}

export async function validateSetupTokenController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = readSetupTokenParam(req);
    const setup = await validateSetupToken(token);

    res.status(200).json({
      ok: true,
      ...setup,
    });
  } catch (error) {
    next(error);
  }
}

export async function completeSetupController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = readSetupTokenParam(req);
    const input = setupPasswordSchema.parse(req.body);
    const setup = await completeSetup(token, input);

    res.status(200).json({
      ok: true,
      ...setup,
    });
  } catch (error) {
    next(error);
  }
}

export async function verifyPasswordController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = res.locals.user;

    if (!user) {
      throw new HttpError(401, 'Session required.');
    }

    const password = req.body.password;
    if (!password || typeof password !== 'string') {
      throw new HttpError(400, 'Password is required.');
    }

    if (!user.passwordHash) {
      throw new HttpError(400, 'Password setup is not complete.');
    }

    const passwordIsValid = await verifyPassword(password, user.passwordHash);

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

export async function changePasswordController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = changePasswordSchema.parse(req.body);
    const user = res.locals.user;
    const userSession = res.locals.userSession;

    if (!user || !userSession) {
      throw new HttpError(401, 'Session required.');
    }

    await changePassword(user.id, userSession.id, input);

    res.status(200).json({
      ok: true,
    });
  } catch (error) {
    next(error);
  }
}
