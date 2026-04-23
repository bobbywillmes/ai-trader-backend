import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

import { getNormalizedOpenOrders } from '../services/orders.service.js';
import { submitOrder } from '../services/place-order.service.js';
import { placeOrderSchema } from '../validators/place-order.schema.js';

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