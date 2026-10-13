import type { Request, Response, NextFunction } from 'express';
import { getRecentOrderIntents, getOrderIntentById } from '../services/order-audit.service.js';
import { HttpError } from '../errors/http-error.js';
import {
  getAccessibleOrderIntentOperationalEvidence,
  listAccessibleOrderIntentHistory,
  ORDER_EVIDENCE_QUERY_LIMITS,
} from '../services/order-intent-operational-evidence.service.js';

function authenticatedUser(res: Response) {
  if (!res.locals.user) throw new HttpError(401, 'Authentication required.');
  return res.locals.user;
}

function positiveInteger(value: unknown, field: string, fallback: number, maximum?: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || (maximum !== undefined && parsed > maximum)) {
    throw new HttpError(400, `${field} must be a positive integer${maximum ? ` no greater than ${maximum}` : ''}.`);
  }
  return parsed;
}

function optionalDate(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${field} must be a valid date.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${field} must be a valid date.`);
  return date;
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function accountFilter(value: unknown) {
  if (value === 'all') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new HttpError(400, 'account must be a positive integer or all.');
  return parsed;
}

export async function orderIntentsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const limit = Number(req.query.limit ?? 50);
    const intents = await getRecentOrderIntents(limit);

    res.status(200).json(intents);
  } catch (error) {
    next(error);
  }
}

export async function orderIntentByIdController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid order intent id.'
      });
      return;
    }

    const intent = await getOrderIntentById(id);

    res.status(200).json({
      intent: {
        id: intent.id,
        source: intent.source,
        symbol: intent.symbol,
        side: intent.side,
        orderType: intent.orderType,
        timeInForce: intent.timeInForce,
        qty: intent.qty,
        notional: intent.notional,
        limitPrice: intent.limitPrice,
        extendedHours: intent.extendedHours,
        clientOrderId: intent.clientOrderId,
        status: intent.status,
        blockReason: intent.blockReason,
        tradingAccountId: intent.tradingAccountId ?? null,
        tradingAccount: intent.tradingAccount ?? null,
        tradingAccountSubscriptionId:
          intent.tradingAccountSubscriptionId ?? null,
        subscriptionId: intent.subscriptionId ?? null,
        subscriptionKey: intent.subscriptionKey ?? null,
        rawRequestJson: intent.rawRequestJson,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
      },
      brokerOrders: intent.brokerOrders
    });
  } catch (error) {
    next(error);
  }
}

export async function orderIntentHistoryController(req: Request, res: Response, next: NextFunction) {
  try {
    const dateFrom = optionalDate(req.query.dateFrom, 'dateFrom');
    const dateTo = optionalDate(req.query.dateTo, 'dateTo');
    if (dateFrom && dateTo && dateFrom > dateTo) throw new HttpError(400, 'dateFrom must not be after dateTo.');
    res.status(200).json(await listAccessibleOrderIntentHistory(authenticatedUser(res), {
      accountId: accountFilter(req.query.account),
      page: positiveInteger(req.query.page, 'page', 1),
      pageSize: positiveInteger(req.query.pageSize, 'pageSize', 25, ORDER_EVIDENCE_QUERY_LIMITS.maxHistoryPageSize),
      ...(optionalText(req.query.symbol) ? { symbol: optionalText(req.query.symbol)! } : {}),
      ...(optionalText(req.query.status) ? { status: optionalText(req.query.status)! } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    }));
  } catch (error) { next(error); }
}

export async function orderIntentOperationalEvidenceController(req: Request, res: Response, next: NextFunction) {
  try {
    const orderIntentId = positiveInteger(req.params.orderIntentId, 'orderIntentId', 0);
    const includeRawEvidence = req.query.rawEvidence === 'true';
    if (req.query.rawEvidence !== undefined && req.query.rawEvidence !== 'true' && req.query.rawEvidence !== 'false') {
      throw new HttpError(400, 'rawEvidence must be true or false.');
    }
    res.status(200).json(await getAccessibleOrderIntentOperationalEvidence(authenticatedUser(res), orderIntentId, {
      opportunityPage: positiveInteger(req.query.opportunityPage, 'opportunityPage', 1),
      opportunityPageSize: positiveInteger(req.query.opportunityPageSize, 'opportunityPageSize', 10, ORDER_EVIDENCE_QUERY_LIMITS.maxOpportunityPageSize),
      eventPage: positiveInteger(req.query.eventPage, 'eventPage', 1),
      eventPageSize: positiveInteger(req.query.eventPageSize, 'eventPageSize', 25, ORDER_EVIDENCE_QUERY_LIMITS.maxEventPageSize),
      includeRawEvidence,
    }));
  } catch (error) { next(error); }
}
