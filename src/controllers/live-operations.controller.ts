import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors/http-error.js';
import { getLiveOperations } from '../services/live-operations.service.js';

export async function getLiveOperationsController(req: Request, res: Response, next: NextFunction) {
  try {
    const user = res.locals.user;
    if (!user) throw new HttpError(401, 'Authentication required.');
    const raw = req.params.id;
    const id = raw ? Number(Array.isArray(raw) ? raw[0] : raw) : undefined;
    const result = await getLiveOperations({ userId: user.id, role: user.platformRole, ...(id ? { tradingAccountId: id } : {}) });
    if (id && result.accounts.length === 0) throw new HttpError(404, 'Accessible Live TradingAccount was not found.');
    res.json(result);
  } catch (error) { next(error); }
}
