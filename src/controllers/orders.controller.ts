import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

import { getNormalizedOpenOrders } from '../services/orders.service.js';
import { submitOrder } from '../services/place-order.service.js';
import { cancelOrderById } from '../services/cancel-order.service.js';
import { cancelAllOpenOrders } from '../services/cancel-all-orders.service.js';
import { placeOrderSchema } from '../validators/place-order.schema.js';
import { cancelOrderParamsSchema } from '../validators/cancel-order.schema.js';

export async function openOrdersController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const orders = await getNormalizedOpenOrders();
    res.status(200).json(orders);
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

    res.status(result.duplicate ? 200 : 201).json(result);
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
    const result = await cancelOrderById(orderId);

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
    const result = await cancelAllOpenOrders();
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}