import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  getTradingAccountForAdmin: vi.fn(),
  listTradingAccountsForAdmin: vi.fn(),
}));

vi.mock('../services/trading-account.service.js', () => ({
  getTradingAccountForAdmin: mocks.getTradingAccountForAdmin,
  listTradingAccountsForAdmin: mocks.listTradingAccountsForAdmin,
}));

import {
  getTradingAccountController,
  listTradingAccountsController,
} from './trading-accounts.controller.js';

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };

  res.status.mockReturnValue(res);

  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe('trading accounts controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listTradingAccountsForAdmin.mockResolvedValue([{ id: 1 }]);
    mocks.getTradingAccountForAdmin.mockResolvedValue({ id: 1 });
  });

  it('returns trading account list responses', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listTradingAccountsController({} as Request, res, next);

    expect(mocks.listTradingAccountsForAdmin).toHaveBeenCalledWith();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ accounts: [{ id: 1 }] });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns trading account detail by id', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountController(
      {
        params: {
          id: '1',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountForAdmin).toHaveBeenCalledWith(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ account: { id: 1 } });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid trading account ids', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountController(
      {
        params: {
          id: 'nope',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account id.',
      })
    );
  });

  it('returns not found for missing trading accounts', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.getTradingAccountForAdmin.mockResolvedValue(null);

    await getTradingAccountController(
      {
        params: {
          id: '404',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountForAdmin).toHaveBeenCalledWith(404);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });
});
