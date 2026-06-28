import type { NextFunction, Request, Response } from 'express';

import { HttpError } from '../errors/http-error.js';
import {
  getTradingAccountForAdmin,
  listTradingAccountsForAdmin,
} from '../services/trading-account.service.js';

function parseTradingAccountId(value: unknown) {
  const id = typeof value === 'string' ? Number(value) : NaN;

  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Invalid trading account id.');
  }

  return id;
}

export async function listTradingAccountsController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accounts = await listTradingAccountsForAdmin();

    res.status(200).json({ accounts });
  } catch (error) {
    next(error);
  }
}

export async function getTradingAccountController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const account = await getTradingAccountForAdmin(id);

    if (!account) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json({ account });
  } catch (error) {
    next(error);
  }
}
