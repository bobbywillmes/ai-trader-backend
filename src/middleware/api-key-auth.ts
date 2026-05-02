import type { Request, Response, NextFunction } from 'express';

import { getAdminSessionFromToken } from '../services/admin-auth.service.js';

function readApiKey(req: Request) {
  return req.header('ai-trader-api-key');
}

function readBearerToken(req: Request) {
  const authHeader = req.header('authorization') ?? '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token.trim();
}

export function requireSignalApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const providedKey = readApiKey(req);

  const signalKey = process.env.AI_TRADER_SIGNAL_API_KEY;
  const adminKey = process.env.AI_TRADER_ADMIN_API_KEY;

  if (!providedKey || !signalKey) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid API key.',
    });
    return;
  }

  // Admin key can also access signal-level routes.
  if (providedKey === signalKey || providedKey === adminKey) {
    next();
    return;
  }

  res.status(401).json({
    error: 'Unauthorized',
    message: 'Missing or invalid API key.',
  });
}

export function requireAdminApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const providedKey = readApiKey(req);

  const adminKey = process.env.AI_TRADER_ADMIN_API_KEY;

  if (providedKey !== adminKey) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin API key required.',
    });
    return;
  }

  next();
}

export async function requireAdminAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const providedApiKey = readApiKey(req);
  const adminApiKey = process.env.AI_TRADER_ADMIN_API_KEY;

  // Static admin API key still works for Postman / maintenance.
  if (providedApiKey && adminApiKey && providedApiKey === adminApiKey) {
    next();
    return;
  }

  const bearerToken = readBearerToken(req);

  if (!bearerToken) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Admin API key or admin session token required.',
    });
    return;
  }

  const session = await getAdminSessionFromToken(bearerToken);

  if (!session) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired admin session.',
    });
    return;
  }

  res.locals.adminUser = session.adminUser;
  res.locals.adminSession = session;

  next();
}