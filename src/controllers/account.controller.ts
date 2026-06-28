import type { Request, Response, NextFunction } from 'express';
import { getNormalizedAccount } from '../services/account.service.js';
import { resolveDefaultTradingAccountId } from '../services/trading-account.service.js';

export async function accountController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const tradingAccountId = await resolveDefaultTradingAccountId();
    const account = await getNormalizedAccount('manual_admin_action', {
      tradingAccountId,
    });
    res.status(200).json(account);
  } catch (error) {
    next(error);
  }
}
