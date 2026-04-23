import type { Request, Response, NextFunction } from 'express';
import { getNormalizedAccount } from '../services/account.service.js';

export async function accountController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const account = await getNormalizedAccount();
    res.status(200).json(account);
  } catch (error) {
    next(error);
  }
}