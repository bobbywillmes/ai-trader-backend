import type { Request, Response, NextFunction } from 'express';
import { getRecentOrderIntents, getOrderIntentById } from '../services/order-audit.service.js';

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
        rawRequestJson: intent.rawRequestJson,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt
      },
      brokerOrders: intent.brokerOrders
    });
  } catch (error) {
    next(error);
  }
}