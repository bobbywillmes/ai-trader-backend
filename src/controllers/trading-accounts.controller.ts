import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { HttpError } from '../errors/http-error.js';
import {
  getTradingAccountForAdmin,
  listTradingAccountsForAdmin,
  updateTradingAccountForAdmin,
} from '../services/trading-account.service.js';
import {
  revokeTradingAccountCredential,
  upsertTradingAccountApiKeyCredential,
} from '../services/trading-account-credential.service.js';
import {
  updateTradingAccountSchema,
  upsertTradingAccountCredentialSchema,
} from '../validators/trading-account.schema.js';
import { verifyTradingAccountCredential } from '../services/trading-account-credential-verification.service.js';

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

export async function updateTradingAccountController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const input = updateTradingAccountSchema.parse(req.body);
    const account = await updateTradingAccountForAdmin(id, input);

    if (!account) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json({ account });
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(400, 'Invalid trading account update request.', error.flatten())
      );
      return;
    }

    next(error);
  }
}

export async function upsertTradingAccountCredentialController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const input = upsertTradingAccountCredentialSchema.parse(req.body);
    const credential = await upsertTradingAccountApiKeyCredential(id, input);

    if (!credential) {
      throw new HttpError(404, 'Trading account not found.');
    }

    const account = await getTradingAccountForAdmin(id);

    if (!account) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json({ account });
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid trading account credential request.',
          error.flatten()
        )
      );
      return;
    }

    next(error);
  }
}

export async function verifyTradingAccountCredentialController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const result = await verifyTradingAccountCredential(id);

    if (!result) {
      throw new HttpError(404, 'Trading account not found.');
    }

    if (!result.ok) {
      res.status(400).json({
        error: 'CredentialVerificationFailed',
        message: result.message,
        account: result.account,
      });
      return;
    }

    res.status(200).json({ account: result.account });
  } catch (error) {
    next(error);
  }
}

export async function revokeTradingAccountCredentialController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const result = await revokeTradingAccountCredential(id);

    if (!result) {
      throw new HttpError(404, 'Trading account not found.');
    }

    const account = await getTradingAccountForAdmin(id);

    if (!account) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json({
      revoked: result.revoked,
      account,
    });
  } catch (error) {
    next(error);
  }
}
