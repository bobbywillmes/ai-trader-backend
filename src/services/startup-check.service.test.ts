import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock('../config/env.js', () => ({
  env: {
    PORT: 3000,
    NODE_ENV: 'development',
    ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
    AI_TRADER_ADMIN_API_KEY: 'admin',
    AI_TRADER_SIGNAL_API_KEY: 'signal',
    ALLOW_LIVE_TRADING: false,
    ALLOW_TRADING_ENABLED_ON_START: false,
  },
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {},
}));

vi.mock('./config.service.js', () => ({
  getRuntimeTradingConfig: vi.fn(),
}));

vi.mock('../config/cors.js', () => ({
  allowedCorsOrigins: ['http://localhost:5173'],
}));

import {
  logStartupReport,
  type StartupCheckReport,
} from './startup-check.service.js';

function report(
  checks: StartupCheckReport['checks'],
  blockStartup = false
): StartupCheckReport {
  return {
    ok: !blockStartup,
    environment: 'development',
    blockStartup,
    checks,
    timestamp: '2026-07-27T12:00:00.000Z',
  };
}

describe('startup status logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits one short readable application status item', () => {
    logStartupReport(report([
      { name: 'database', status: 'pass', message: 'Database is reachable.' },
      {
        name: 'runtime_config',
        status: 'pass',
        message: 'Runtime trading config loaded.',
        details: {
          tradingEnabled: true,
          paperMode: true,
          killSwitchEnabled: false,
        },
      },
      {
        name: 'development_trading_enabled',
        status: 'warn',
        message: 'Trading is enabled in a non-production environment.',
      },
    ]));

    expect(mocks.loggerInfo).not.toHaveBeenCalled();
    expect(mocks.loggerError).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(2);
    expect(mocks.loggerWarn).toHaveBeenNthCalledWith(
      1,
      'AI Trader Backend ready: development | database connected | ' +
        'entry trading enabled | 2 checks passed | 1 warning | http://localhost:3000'
    );
    expect(mocks.loggerWarn).toHaveBeenNthCalledWith(
      2,
      'Warnings: Trading is enabled in a non-production environment.'
    );
  });

  it('emits one error summary when startup is blocked', () => {
    logStartupReport(report([
      {
        name: 'database',
        status: 'fail',
        message: 'Database is not reachable.',
      },
    ], true));

    expect(mocks.loggerInfo).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledOnce();
    expect(mocks.loggerError.mock.calls[0]?.[0]).toContain(
      'AI Trader Backend startup blocked'
    );
    expect(mocks.loggerError.mock.calls[0]?.[0]).toContain(
      '1 failed (database)'
    );
  });
});
