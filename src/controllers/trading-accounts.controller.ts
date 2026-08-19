import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { HttpError } from '../errors/http-error.js';
import { isSystemOwnerRole } from '../types/platform-rbac.js';
import {
  getTradingAccountForAdmin,
  createTradingAccountForAdmin,
  activateTradingAccountForAdmin,
  deactivateTradingAccountForAdmin,
  listTradingAccountsForAdmin,
  listTradingAccountsForUser,
  updateTradingAccountForAdmin,
} from '../services/trading-account.service.js';
import {
  getScopedOpenOrdersForAccount,
  getScopedOpenPositionsForAccount,
} from '../services/operational-scope.service.js';
import {
  listTradeCyclesForTradingAccount,
  type TradeCycleFilters,
} from '../services/trade-cycles.service.js';
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
  deleteTradingAccountSubscriptionForAdmin,
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
  createTradingAccountSchema,
  activateTradingAccountSchema,
  createTradingAccountSubscriptionSchema,
  deactivateTradingAccountSchema,
  entryRiskPreviewSchema,
  updateTradingAccountRiskSettingsSchema,
  updateTradingAccountSchema,
  updateTradingAccountAllocationSchema,
  updateTradingAccountSubscriptionSchema,
  upsertTradingAccountCredentialSchema,
  runTradingAccountReadinessAssessmentSchema,
  tradingAccountReadinessPurposeSchema,
  liveWriteCapabilitySchema,
  grantLiveWriteApprovalSchema,
  revokeLiveWriteApprovalSchema,
  stageLiveEntryCanarySchema,
  armLiveEntriesSchema,
  disarmLiveEntriesSchema,
} from '../validators/trading-account.schema.js';
import { verifyTradingAccountCredential } from '../services/trading-account-credential-verification.service.js';
import {
  getTradingAccountRiskSettingsForAdmin,
  updateTradingAccountRiskSettingsForAdmin,
} from '../services/trading-account-risk-settings.service.js';
import { previewTradingAccountEntryRisk } from '../services/trading-account-entry-risk-preview.service.js';
import { getTradingAccountRiskHealth } from '../services/trading-account-risk-health.service.js';
import { listTradingAccountWorkerHealth } from '../services/trading-account-worker-health.service.js';
import {
  getLatestTradingAccountReadinessAssessment,
  getTradingAccountReadinessAssessment,
  listTradingAccountReadinessAssessments,
  runTradingAccountReadinessAssessment,
} from '../services/trading-account-readiness.service.js';
import {
  getLiveWriteApprovalState,
  grantLiveWriteApproval,
  listLiveWriteApprovalHistory,
  revokeLiveWriteApproval,
} from '../services/live-write-approval.service.js';
import {
  armLiveEntries,
  disarmLiveEntries,
  stageLiveEntryCanary,
} from '../services/live-entry-arming.service.js';

export async function stageLiveEntryCanaryController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = parseTradingAccountId(req.params.id);
    const input = stageLiveEntryCanarySchema.parse(req.body);
    res.status(200).json(await stageLiveEntryCanary({ tradingAccountId, actorUserId: requireActorUserId(res), ...input }));
  } catch (error) { next(error); }
}

export async function armLiveEntriesController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = parseTradingAccountId(req.params.id);
    const input = armLiveEntriesSchema.parse(req.body);
    res.status(200).json(await armLiveEntries(tradingAccountId, requireActorUserId(res), input));
  } catch (error) { next(error); }
}

export async function disarmLiveEntriesController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = parseTradingAccountId(req.params.id);
    const input = disarmLiveEntriesSchema.parse(req.body);
    res.status(200).json(await disarmLiveEntries(tradingAccountId, requireActorUserId(res), input.reason));
  } catch (error) { next(error); }
}

function parseAssessmentId(value: unknown) {
  const id = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Invalid readiness assessment id.');
  }
  return id;
}

function parseReadinessPurpose(value: unknown) {
  const parsed = tradingAccountReadinessPurposeSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(400, 'Invalid readiness assessment purpose.');
  return parsed.data;
}

function parseReadinessLimit(value: unknown) {
  if (value === undefined) return 20;
  const limit = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new HttpError(
      400,
      'Readiness assessment limit must be between 1 and 100.',
    );
  }
  return limit;
}

function parseTradingAccountId(value: unknown) {
  const id = typeof value === 'string' ? Number(value) : NaN;

  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Invalid trading account id.');
  }

  return id;
}

function requireActorUserId(res: Response) {
  const user = res.locals.user;
  if (!user) {
    throw new HttpError(401, 'Authentication required.');
  }
  return user.id;
}

export async function createTradingAccountController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = createTradingAccountSchema.parse(req.body);
    const account = await createTradingAccountForAdmin(input);
    res.status(201).json({ account });
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid trading account creation request.',
          error.flatten(),
        ),
      );
      return;
    }
    next(error);
  }
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
  next: NextFunction,
) {
  try {
    const user = res.locals.user;
    if (!user) {
      throw new HttpError(401, 'Authentication required.');
    }

    const accounts = await listTradingAccountsForUser({
      userId: user.id,
      isSystemOwner:
        isSystemOwnerRole(user.platformRole) ||
        Boolean(res.locals.isStaticAdminKey),
    });

    res.status(200).json({ accounts });
  } catch (error) {
    next(error);
  }
}

export async function getTradingAccountController(
  req: Request,
  res: Response,
  next: NextFunction,
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

function getQueryString(value: unknown) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function getQueryNumber(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getQueryDate(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseTradeCycleStatus(value: unknown): TradeCycleFilters['status'] {
  const status = getQueryString(value);

  if (status === 'open' || status === 'closed' || status === 'closing') {
    return status;
  }

  return undefined;
}

function parseTradeCycleFilters(query: Request['query']) {
  const filters: TradeCycleFilters = {};
  const symbol = getQueryString(query.symbol);
  const status = parseTradeCycleStatus(query.status);
  const dateFrom = getQueryDate(query.dateFrom);
  const dateTo = getQueryDate(query.dateTo);
  const strategyId = getQueryNumber(query.strategyId);
  const subscriptionId = getQueryNumber(query.subscriptionId);
  const exitProfileId = getQueryNumber(query.exitProfileId);
  const exitReason = getQueryString(query.exitReason);
  const mode = getQueryString(query.mode);
  const limit = getQueryNumber(query.limit);

  if (symbol !== undefined) filters.symbol = symbol;
  if (status !== undefined) filters.status = status;
  if (dateFrom !== undefined) filters.dateFrom = dateFrom;
  if (dateTo !== undefined) filters.dateTo = dateTo;
  if (strategyId !== undefined) filters.strategyId = strategyId;
  if (subscriptionId !== undefined) filters.subscriptionId = subscriptionId;
  if (exitProfileId !== undefined) filters.exitProfileId = exitProfileId;
  if (exitReason !== undefined) filters.exitReason = exitReason;
  if (mode !== undefined) filters.mode = mode;
  if (limit !== undefined) filters.limit = limit;

  return filters;
}

export async function listTradingAccountOpenPositionsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    res.status(200).json(await getScopedOpenPositionsForAccount(id));
  } catch (error) {
    next(error);
  }
}

export async function listTradingAccountOpenOrdersController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    res.status(200).json(await getScopedOpenOrdersForAccount(id));
  } catch (error) {
    next(error);
  }
}

export async function listTradingAccountTradeCyclesController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const result = await listTradeCyclesForTradingAccount(
      id,
      parseTradeCycleFilters(req.query),
    );

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function updateTradingAccountController(
  req: Request,
  res: Response,
  next: NextFunction,
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
        new HttpError(
          400,
          'Invalid trading account update request.',
          error.flatten(),
        ),
      );
      return;
    }

    next(error);
  }
}

export async function deactivateTradingAccountController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const input = deactivateTradingAccountSchema.parse(req.body);
    const result = await deactivateTradingAccountForAdmin(
      id,
      input,
      requireActorUserId(res),
    );

    if (!result) {
      throw new HttpError(404, 'Trading account not found.');
    }

    res.status(200).json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid trading account deactivation request.',
          error.flatten(),
        ),
      );
      return;
    }

    next(error);
  }
}

export async function activateTradingAccountController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const input = activateTradingAccountSchema.parse(req.body);
    const result = await activateTradingAccountForAdmin(
      id,
      input,
      requireActorUserId(res),
    );
    if (!result) throw new HttpError(404, 'Trading account not found.');
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid trading account activation request.',
          error.flatten(),
        ),
      );
      return;
    }
    next(error);
  }
}

export async function getTradingAccountRiskSettingsController(
  req: Request,
  res: Response,
  next: NextFunction,
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
  next: NextFunction,
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const input = updateTradingAccountRiskSettingsSchema.parse(req.body);
    const riskSettings = await updateTradingAccountRiskSettingsForAdmin(
      id,
      input,
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
          error.flatten(),
        ),
      );
      return;
    }

    next(error);
  }
}

export async function getTradingAccountRiskHealthController(
  req: Request,
  res: Response,
  next: NextFunction,
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

export async function getTradingAccountWorkerHealthController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await listTradingAccountWorkerHealth(
      parseTradingAccountId(req.params.id),
    );
    if (!result) throw new HttpError(404, 'Trading account not found.');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

export async function previewTradingAccountEntryRiskController(
  req: Request,
  res: Response,
  next: NextFunction,
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
          error.flatten(),
        ),
      );
      return;
    }

    next(error);
  }
}

export async function listTradingAccountAllocationsController(
  req: Request,
  res: Response,
  next: NextFunction,
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
  next: NextFunction,
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const input = createTradingAccountAllocationSchema.parse(req.body);
    const allocation = await createTradingAccountAllocationForAdmin(
      accountId,
      input,
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
          error.flatten(),
        ),
      );
      return;
    }

    next(error);
  }
}

export async function updateTradingAccountAllocationController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const allocationId = parseAllocationId(req.params.allocationId);
    const input = updateTradingAccountAllocationSchema.parse(req.body);
    const allocation = await updateTradingAccountAllocationForAdmin(
      accountId,
      allocationId,
      input,
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
          error.flatten(),
        ),
      );
      return;
    }

    next(error);
  }
}

export async function listTradingAccountSubscriptionsController(
  req: Request,
  res: Response,
  next: NextFunction,
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
  next: NextFunction,
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const accountSubscriptionId = parseAccountSubscriptionId(
      req.params.accountSubscriptionId,
    );
    const accountSubscription = await getTradingAccountSubscriptionForAdmin(
      accountId,
      accountSubscriptionId,
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
  next: NextFunction,
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const symbols = parseSymbolsQuery(req.query.symbols);
    const result = await listAccountSubscriptionMarketContextForAdmin(
      accountId,
      {
        status: parseAccountSubscriptionMarketContextStatus(req.query.status),
        ...(symbols !== undefined && { symbols }),
      },
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
  next: NextFunction,
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const accountSubscriptionId = parseAccountSubscriptionId(
      req.params.accountSubscriptionId,
    );
    const result = await getAccountSubscriptionPriceHistoryForAdmin(
      accountId,
      accountSubscriptionId,
      {
        range: parseAccountSubscriptionPriceHistoryRange(req.query.range),
      },
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
  next: NextFunction,
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const input = createTradingAccountSubscriptionSchema.parse(req.body);
    const accountSubscription = await createTradingAccountSubscriptionForAdmin(
      accountId,
      input,
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
          error.flatten(),
        ),
      );
      return;
    }

    next(error);
  }
}

export async function updateTradingAccountSubscriptionController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const accountSubscriptionId = parseAccountSubscriptionId(
      req.params.accountSubscriptionId,
    );
    const input = updateTradingAccountSubscriptionSchema.parse(req.body);
    const accountSubscription = await updateTradingAccountSubscriptionForAdmin(
      accountId,
      accountSubscriptionId,
      input,
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
          error.flatten(),
        ),
      );
      return;
    }

    next(error);
  }
}

export async function deleteTradingAccountSubscriptionController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const accountId = parseTradingAccountId(req.params.id);
    const accountSubscriptionId = parseAccountSubscriptionId(
      req.params.accountSubscriptionId,
    );
    const deleted = await deleteTradingAccountSubscriptionForAdmin(
      accountId,
      accountSubscriptionId,
    );

    if (!deleted) {
      throw new HttpError(404, 'Trading account subscription not found.');
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export async function upsertTradingAccountCredentialController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const input = upsertTradingAccountCredentialSchema.parse(req.body);
    const credential = await upsertTradingAccountApiKeyCredential(
      id,
      input,
      requireActorUserId(res),
    );

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
          error.flatten(),
        ),
      );
      return;
    }

    next(error);
  }
}

export async function verifyTradingAccountCredentialController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const result = await verifyTradingAccountCredential(
      id,
      requireActorUserId(res),
    );

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
  next: NextFunction,
) {
  try {
    const id = parseTradingAccountId(req.params.id);
    const result = await revokeTradingAccountCredential(
      id,
      requireActorUserId(res),
    );

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

export async function runTradingAccountReadinessAssessmentController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = runTradingAccountReadinessAssessmentSchema.parse(req.body);
    const assessment = await runTradingAccountReadinessAssessment(
      parseTradingAccountId(req.params.id),
      input.purpose,
      requireActorUserId(res),
    );
    res.status(201).json({ assessment });
  } catch (error) {
    if (error instanceof ZodError) {
      next(
        new HttpError(
          400,
          'Invalid readiness assessment request.',
          error.flatten(),
        ),
      );
      return;
    }
    next(error);
  }
}

export async function getLatestTradingAccountReadinessAssessmentController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const assessment = await getLatestTradingAccountReadinessAssessment(
      parseTradingAccountId(req.params.id),
      parseReadinessPurpose(req.query.purpose),
    );
    res.status(200).json({ assessment });
  } catch (error) {
    next(error);
  }
}

export async function listTradingAccountReadinessAssessmentsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const assessments = await listTradingAccountReadinessAssessments(
      parseTradingAccountId(req.params.id),
      parseReadinessPurpose(req.query.purpose),
      parseReadinessLimit(req.query.limit),
    );
    res.status(200).json({ assessments });
  } catch (error) {
    next(error);
  }
}

export async function getTradingAccountReadinessAssessmentController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const assessment = await getTradingAccountReadinessAssessment(
      parseTradingAccountId(req.params.id),
      parseAssessmentId(req.params.assessmentId),
    );
    if (!assessment)
      throw new HttpError(404, 'Readiness assessment not found.');
    res.status(200).json({ assessment });
  } catch (error) {
    next(error);
  }
}

export async function getLiveWriteApprovalsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const tradingAccountId = parseTradingAccountId(req.params.id);
    const [state, history] = await Promise.all([
      getLiveWriteApprovalState(tradingAccountId),
      listLiveWriteApprovalHistory(tradingAccountId),
    ]);
    res.json({ ...state, history });
  } catch (error) {
    next(error);
  }
}

export async function grantLiveWriteApprovalController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const tradingAccountId = parseTradingAccountId(req.params.id);
    const capability = liveWriteCapabilitySchema.parse(req.params.capability);
    const input = grantLiveWriteApprovalSchema.parse(req.body);
    const approval = await grantLiveWriteApproval({
      tradingAccountId,
      capability,
      actorUserId: requireActorUserId(res),
      input,
    });
    res.json({ approval });
  } catch (error) {
    if (error instanceof ZodError)
      return next(
        new HttpError(
          400,
          'Invalid Live write approval request.',
          error.flatten(),
        ),
      );
    next(error);
  }
}

export async function revokeLiveWriteApprovalController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const tradingAccountId = parseTradingAccountId(req.params.id);
    const capability = liveWriteCapabilitySchema.parse(req.params.capability);
    const input = revokeLiveWriteApprovalSchema.parse(req.body);
    const approval = await revokeLiveWriteApproval({
      tradingAccountId,
      capability,
      actorUserId: requireActorUserId(res),
      ...input,
    });
    res.json({ approval });
  } catch (error) {
    if (error instanceof ZodError)
      return next(
        new HttpError(
          400,
          'Invalid Live write approval revocation.',
          error.flatten(),
        ),
      );
    next(error);
  }
}
