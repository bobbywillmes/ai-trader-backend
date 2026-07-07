import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { HttpError } from '../errors/http-error.js';
import { isOwnerRole } from '../types/admin-rbac.js';
import {
  getTradingAccountForAdmin,
  getTradingAccountSummaryById,
  listTradingAccountsForAdmin,
  listTradingAccountsForAdminUser,
  updateTradingAccountForAdmin,
} from '../services/trading-account.service.js';
import { getNormalizedOpenOrders } from '../services/orders.service.js';
import { getOpenTrackedPositionsForTradingAccount } from '../services/position-tracking.service.js';
import {
  revokeTradingAccountCredential,
  upsertTradingAccountApiKeyCredential,
} from '../services/trading-account-credential.service.js';
import {
  createTradingAccountAllocationForAdmin,
  listTradingAccountAllocationsForAdmin,
  updateTradingAccountAllocationForAdmin,
} from '../services/trading-account-allocation.service.js';
import {
  createTradingAccountSubscriptionForAdmin,
  getTradingAccountSubscriptionForAdmin,
  listTradingAccountSubscriptionsForAdmin,
  updateTradingAccountSubscriptionForAdmin,
} from '../services/trading-account-subscription.service.js';
import {
  getAccountSubscriptionPriceHistoryForAdmin,
  listAccountSubscriptionMarketContextForAdmin,
  parseAccountSubscriptionMarketContextStatus,
  parseAccountSubscriptionPriceHistoryRange,
} from '../services/account-subscription-market-context.service.js';
import {
  createTradingAccountAllocationSchema,
  createTradingAccountSubscriptionSchema,
  entryRiskPreviewSchema,
  updateTradingAccountRiskSettingsSchema,
  updateTradingAccountSchema,
  updateTradingAccountAllocationSchema,
  updateTradingAccountSubscriptionSchema,
  upsertTradingAccountCredentialSchema,
} from '../validators/trading-account.schema.js';
import { verifyTradingAccountCredential } from '../services/trading-account-credential-verification.service.js';
import {
  getTradingAccountRiskSettingsForAdmin,
  updateTradingAccountRiskSettingsForAdmin,
} from '../services/trading-account-risk-settings.service.js';
import { previewTradingAccountEntryRisk } from '../services/trading-account-entry-risk-preview.service.js';
import { getTradingAccountRiskHealth } from '../services/trading-account-risk-health.service.js';

function parseTradingAccountId(value: unknown) {
  const id = typeof value === 'string' ? Number(value) : NaN;

  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Invalid trading account id.');
  }

  return id;
}

function parseAllocationId(value: unknown) {
  const id = typeof value === 'string' ? Number(value) : NaN;

  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Invalid trading account allocation id.');
  }

  return id;
}

function parseAccountSubscriptionId(value: unknown) {
  const id = typeof value === 'string' ? Number(value) : NaN;

  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Invalid trading account subscription id.');
  }

  return id;
}

function parseSymbolsQuery(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const symbols = value
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);

  return symbols.length > 0 ? symbols : undefined;
}

export async function listTradingAccountsController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const adminUser = res.locals.adminUser;

    const accounts = await listTradingAccountsForAdminUser({
      adminUserId: adminUser.id,
      isOwner: isOwnerRole(adminUser.role) || Boolean(res.locals.isStaticAdminKey),
    });

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

export async function listTradingAccountOpenPositionsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const positions = await getOpenTrackedPositionsForTradingAccount(id);

    res.status(200).json({ positions });
  } catch (error) {
    next(error);
  }
}

export async function listTradingAccountOpenOrdersController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const tradingAccount = await getTradingAccountSummaryById(id);

    if (!tradingAccount) {
      throw new HttpError(404, 'Trading account not found.');
    }

    const orders = await getNormalizedOpenOrders('open_orders_sync', {
      tradingAccountId: id,
    });

    res.status(200).json({
      orders: orders.map((order) => ({
        ...order,
        tradingAccountId: id,
        tradingAccount,
      })),
    });
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

export async function getTradingAccountRiskSettingsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const riskSettings = await getTradingAccountRiskSettingsForAdmin(id);

    if (!riskSettings) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json({ riskSettings });
  } catch (error) {
    next(error);
  }
}

export async function updateTradingAccountRiskSettingsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const input = updateTradingAccountRiskSettingsSchema.parse(req.body);
    const riskSettings = await updateTradingAccountRiskSettingsForAdmin(
      id,
      input
    );

    if (!riskSettings) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json({ riskSettings });
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid trading account risk settings request.',
          error.flatten()
        )
      );
      return;
    }

    next(error);
  }
}

export async function getTradingAccountRiskHealthController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const riskHealth = await getTradingAccountRiskHealth(id);

    if (!riskHealth) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json({ riskHealth });
  } catch (error) {
    next(error);
  }
}

export async function previewTradingAccountEntryRiskController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const input = entryRiskPreviewSchema.parse(req.body);
    const preview = await previewTradingAccountEntryRisk(id, input);

    if (!preview) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json({ preview });
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid entry risk preview request.',
          error.flatten()
        )
      );
      return;
    }

    next(error);
  }
}

export async function listTradingAccountAllocationsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const allocations = await listTradingAccountAllocationsForAdmin(accountId);

    if (!allocations) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json({ allocations });
  } catch (error) {
    next(error);
  }
}

export async function createTradingAccountAllocationController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const input = createTradingAccountAllocationSchema.parse(req.body);
    const allocation = await createTradingAccountAllocationForAdmin(
      accountId,
      input
    );

    if (!allocation) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(201).json({ allocation });
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid trading account allocation request.',
          error.flatten()
        )
      );
      return;
    }

    next(error);
  }
}

export async function updateTradingAccountAllocationController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const allocationId = parseAllocationId(req.params.allocationId);
    const input = updateTradingAccountAllocationSchema.parse(req.body);
    const allocation = await updateTradingAccountAllocationForAdmin(
      accountId,
      allocationId,
      input
    );

    if (!allocation) {
      throw new HttpError(404, 'Trading account allocation not found.');
    }

    res.status(200).json({ allocation });
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid trading account allocation request.',
          error.flatten()
        )
      );
      return;
    }

    next(error);
  }
}

export async function listTradingAccountSubscriptionsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const accountSubscriptions =
      await listTradingAccountSubscriptionsForAdmin(accountId);

    if (!accountSubscriptions) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json({ accountSubscriptions });
  } catch (error) {
    next(error);
  }
}

export async function getTradingAccountSubscriptionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const accountSubscriptionId = parseAccountSubscriptionId(
      req.params.accountSubscriptionId
    );
    const accountSubscription = await getTradingAccountSubscriptionForAdmin(
      accountId,
      accountSubscriptionId
    );

    if (!accountSubscription) {
      throw new HttpError(404, 'Trading account subscription not found.');
    }

    res.status(200).json({ accountSubscription });
  } catch (error) {
    next(error);
  }
}

export async function listTradingAccountSubscriptionMarketContextController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const symbols = parseSymbolsQuery(req.query.symbols);
    const result = await listAccountSubscriptionMarketContextForAdmin(
      accountId,
      {
        status: parseAccountSubscriptionMarketContextStatus(req.query.status),
        ...(symbols !== undefined && { symbols }),
      }
    );

    if (!result) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function getTradingAccountSubscriptionPriceHistoryController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const accountSubscriptionId = parseAccountSubscriptionId(
      req.params.accountSubscriptionId
    );
    const result = await getAccountSubscriptionPriceHistoryForAdmin(
      accountId,
      accountSubscriptionId,
      {
        range: parseAccountSubscriptionPriceHistoryRange(req.query.range),
      }
    );

    if (!result) {
      throw new HttpError(404, 'Trading account subscription not found.');
    }

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function createTradingAccountSubscriptionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const input = createTradingAccountSubscriptionSchema.parse(req.body);
    const accountSubscription = await createTradingAccountSubscriptionForAdmin(
      accountId,
      input
    );

    if (!accountSubscription) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(201).json({ accountSubscription });
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid trading account subscription request.',
          error.flatten()
        )
      );
      return;
    }

    next(error);
  }
}

export async function updateTradingAccountSubscriptionController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const accountSubscriptionId = parseAccountSubscriptionId(
      req.params.accountSubscriptionId
    );
    const input = updateTradingAccountSubscriptionSchema.parse(req.body);
    const accountSubscription = await updateTradingAccountSubscriptionForAdmin(
      accountId,
      accountSubscriptionId,
      input
    );

    if (!accountSubscription) {
      throw new HttpError(404, 'Trading account subscription not found.');
    }

    res.status(200).json({ accountSubscription });
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid trading account subscription request.',
          error.flatten()
        )
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
