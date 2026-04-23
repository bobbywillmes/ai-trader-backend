import type { Request, Response, NextFunction } from 'express';
import { getNormalizedOpenOrders } from '../services/orders.service.js';

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