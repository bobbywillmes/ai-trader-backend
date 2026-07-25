import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

import { getNormalizedOpenOrders } from '../services/orders.service.js';
import { submitOrder } from '../services/place-order.service.js';
import { cancelOrderById } from '../services/cancel-order.service.js';
import { cancelAllOpenOrders } from '../services/cancel-all-orders.service.js';
import { placeOrderSchema } from '../validators/place-order.schema.js';
import { cancelOrderParamsSchema } from '../validators/cancel-order.schema.js';
import {
  getTradingAccountSummaryById,
  resolveDefaultTradingAccountId,
} from '../services/trading-account.service.js';

export async function openOrdersController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const tradingAccountId = await resolveDefaultTradingAccountId();
    const [orders, tradingAccount] = await Promise.all([
      getNormalizedOpenOrders(tradingAccountId, 'manual_admin_action'),
      getTradingAccountSummaryById(tradingAccountId),
    ]);
    res.status(200).json(
      orders.map((order) => ({
        ...order,
        tradingAccountId,
        tradingAccount,
      }))
    );
  } catch (error) {
    next(error);
  }
}

export async function placeOrderController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const input = placeOrderSchema.parse(req.body);
    const result = await submitOrder(input);

    let status = undefined;
    if ('duplicate' in result && result.duplicate) {
      status = 200; // OK
    } else {
       status = 201; // Created
    }

    res.status(status).json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid order request.',
        details: error.flatten()
      });
      return;
    }

    next(error);
  }
}

export async function cancelOrderController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { orderId } = cancelOrderParamsSchema.parse(req.params);
    const tradingAccountId = res.locals.authorizedTradingAccountId;
    if (tradingAccountId === undefined) {
      throw new Error('Authorized Trading Account scope is missing.');
    }
    const result = await cancelOrderById(tradingAccountId, orderId);

    res.status(200).json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Invalid cancel order request.',
        details: error.flatten()
      });
      return;
    }

    next(error);
  }
}

export async function cancelAllOrdersController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const tradingAccountId = res.locals.authorizedTradingAccountId;
    if (tradingAccountId === undefined) {
      throw new Error('Authorized Trading Account scope is missing.');
    }
    const result = await cancelAllOpenOrders(tradingAccountId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
