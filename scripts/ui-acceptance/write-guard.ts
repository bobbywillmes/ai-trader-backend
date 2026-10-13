import type { RequestHandler } from 'express';

const allowed = new Set(['POST /api/auth/login', 'POST /api/auth/logout']);

export const acceptanceReadOnlyGuard: RequestHandler = (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (allowed.has(`${req.method} ${req.path}`)) return next();
  res.status(405).json({ error: 'AcceptanceReadOnly', message: 'Business writes are disabled in the Phase 3B.4 acceptance environment.' });
};
