import type { Request, Response, NextFunction } from 'express';

function readApiKey(req: Request) {
  return req.header('ai-trader-api-key');
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