import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getRuntimeTradingConfig } from './config.service.js';
import { allowedCorsOrigins } from '../config/cors.js';

type StartupCheckStatus = 'pass' | 'warn' | 'fail';

type StartupCheck = {
  name: string;
  status: StartupCheckStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type StartupCheckReport = {
  ok: boolean;
  environment: string;
  blockStartup: boolean;
  checks: StartupCheck[];
  timestamp: string;
};

export class StartupCheckError extends Error {
  report: StartupCheckReport;

  constructor(report: StartupCheckReport) {
    super('Startup checks failed.');
    this.name = 'StartupCheckError';
    this.report = report;
  }
}

function makeCheck(
  name: string,
  status: StartupCheckStatus,
  message: string,
  details?: Record<string, unknown>
): StartupCheck {
  const check: StartupCheck = {
    name,
    status,
    message,
  };

  if (details !== undefined) {
    check.details = details;
  }

  return check;
}

function pass(
  name: string,
  message: string,
  details?: Record<string, unknown>
): StartupCheck {
  return makeCheck(name, 'pass', message, details);
}

function warn(
  name: string,
  message: string,
  details?: Record<string, unknown>
): StartupCheck {
  return makeCheck(name, 'warn', message, details);
}

function fail(
  name: string,
  message: string,
  details?: Record<string, unknown>
): StartupCheck {
  return makeCheck(name, 'fail', message, details);
}

function isPaperAlpacaBaseUrl(value: string) {
  return value.includes('paper-api.alpaca.markets');
}

function logStartupReport(report: StartupCheckReport) {
  for (const check of report.checks) {
    const payload = {
      check: check.name,
      status: check.status,
      details: check.details,
    };

    if (check.status === 'fail') {
      logger.error(payload, check.message);
    } else if (check.status === 'warn') {
      logger.warn(payload, check.message);
    } else {
      logger.info(payload, check.message);
    }
  }
}

function isLocalhostOrigin(origin: string) {
  return (
    origin.includes('localhost') ||
    origin.includes('127.0.0.1') ||
    origin.includes('0.0.0.0')
  );
}

function isWildcardOrigin(origin: string) {
  return origin === '*';
}

export async function runStartupChecks(): Promise<StartupCheckReport> {
  const checks: StartupCheck[] = [];
  const isProduction = env.NODE_ENV === 'production';


  const deprecatedRuntimeEnvKeys = ['paperMode', 'tradingEnabled'];

  for (const key of deprecatedRuntimeEnvKeys) {
    if (process.env[key] !== undefined) {
      checks.push(
        warn(
          'deprecated_runtime_env_key',
          `${key} is set in the environment, but runtime trading settings are loaded from the database Setting table.`,
          {
            envKey: key,
            envValue: process.env[key],
            sourceOfTruth: 'Setting table',
          }
        )
      );
    }
  }

  try {
    await prisma.$queryRaw`SELECT 1`;

    checks.push(pass('database', 'Database is reachable.'));
  } catch (error) {
    checks.push(
      fail('database', 'Database is not reachable.', {
        error: error instanceof Error ? error.message : 'Unknown database error',
      })
    );
  }

  try {
    const config = await getRuntimeTradingConfig();
    const usingPaperBrokerUrl = isPaperAlpacaBaseUrl(env.ALPACA_BASE_URL);

    checks.push(
      pass('runtime_config', 'Runtime trading config loaded.', {
        tradingEnabled: config.tradingEnabled,
        paperMode: config.paperMode,
        killSwitchEnabled: config.killSwitchEnabled,
      })
    );

    if (env.AI_TRADER_ADMIN_API_KEY === env.AI_TRADER_SIGNAL_API_KEY) {
      checks.push(
        fail(
          'api_key_separation',
          'Admin and signal API keys must be different.'
        )
      );
    } else {
      checks.push(
        pass('api_key_separation', 'Admin and signal API keys are separated.')
      );
    }

    if (config.paperMode && !usingPaperBrokerUrl) {
      checks.push(
        fail(
          'paper_mode_broker_url',
          'Runtime config is in paper mode, but ALPACA_BASE_URL does not point to the Alpaca paper API.',
          {
            paperMode: config.paperMode,
            alpacaBaseUrl: env.ALPACA_BASE_URL,
          }
        )
      );
    }

    if (!config.paperMode && usingPaperBrokerUrl) {
      checks.push(
        fail(
          'live_mode_broker_url',
          'Runtime config is in live mode, but ALPACA_BASE_URL still points to the Alpaca paper API.',
          {
            paperMode: config.paperMode,
            alpacaBaseUrl: env.ALPACA_BASE_URL,
          }
        )
      );
    }

    if (isProduction && !config.paperMode && !env.ALLOW_LIVE_TRADING) {
      checks.push(
        fail(
          'production_live_trading_guard',
          'Production startup is configured for live trading, but ALLOW_LIVE_TRADING is not enabled.'
        )
      );
    }

    if (allowedCorsOrigins.length === 0) {
      checks.push(
        fail(
          'cors_allowed_origins',
          'CORS_ALLOWED_ORIGINS must include at least one allowed admin UI origin.'
        )
      );
    } else {
      checks.push(
        pass('cors_allowed_origins', 'CORS allowed origins configured.', {
          allowedCorsOrigins,
        })
      );
    }

    if (allowedCorsOrigins.some(isWildcardOrigin)) {
      checks.push(
        fail(
          'cors_wildcard_origin',
          'Wildcard CORS origin is not allowed. Configure explicit admin UI origins instead.',
          {
            allowedCorsOrigins,
          }
        )
      );
    }

    if (isProduction && allowedCorsOrigins.some(isLocalhostOrigin)) {
      checks.push(
        fail(
          'production_localhost_cors_origin',
          'Production CORS config includes a localhost origin. Configure the deployed admin UI origin before production startup.',
          {
            allowedCorsOrigins,
          }
        )
      );
    }

    if (!isProduction && allowedCorsOrigins.some(isLocalhostOrigin)) {
      checks.push(
        pass('development_localhost_cors_origin', 'Development localhost CORS origin configured.', {
          allowedCorsOrigins,
        })
      );
    }

    if (
      isProduction &&
      config.tradingEnabled &&
      !env.ALLOW_TRADING_ENABLED_ON_START
    ) {
      checks.push(
        fail(
          'production_trading_enabled_on_start_guard',
          'Production startup found database runtime setting tradingEnabled=true. Set ALLOW_TRADING_ENABLED_ON_START=true only when intentionally restarting production with trading already enabled.',
          {
            source: 'Setting table',
            settingKey: 'tradingEnabled',
            tradingEnabled: config.tradingEnabled,
          }
        )
      );
    }

    if (!isProduction && config.tradingEnabled) {
      checks.push(
        warn(
          'development_trading_enabled',
          'Trading is enabled in a non-production environment.',
          {
            nodeEnv: env.NODE_ENV,
            tradingEnabled: config.tradingEnabled,
          }
        )
      );
    }

    if (isProduction && !config.tradingEnabled) {
      checks.push(
        pass(
          'production_trading_disabled_on_start',
          'Production startup is safe: tradingEnabled=false.'
        )
      );
    }
  } catch (error) {
    checks.push(
      fail('runtime_config', 'Runtime trading config could not be loaded.', {
        error: error instanceof Error ? error.message : 'Unknown runtime config error',
      })
    );
  }



if (isProduction && env.ALLOW_LIVE_TRADING) {
  checks.push(
    warn(
      'production_live_trading_override_enabled',
      'ALLOW_LIVE_TRADING=true is enabled. This should only be used intentionally for live trading.',
      {
        allowLiveTrading: env.ALLOW_LIVE_TRADING,
      }
    )
  );
}

if (isProduction && env.ALLOW_TRADING_ENABLED_ON_START) {
  checks.push(
    warn(
      'production_trading_enabled_on_start_override_enabled',
      'ALLOW_TRADING_ENABLED_ON_START=true is enabled. This should usually be temporary and reset to false after startup recovery.',
      {
        allowTradingEnabledOnStart: env.ALLOW_TRADING_ENABLED_ON_START,
      }
    )
  );
}



  const failedChecks = checks.filter((check) => check.status === 'fail');

  return {
    ok: failedChecks.length === 0,
    environment: env.NODE_ENV,
    blockStartup: failedChecks.length > 0,
    checks,
    timestamp: new Date().toISOString(),
  };
}

export async function assertStartupSafe() {
  const report = await runStartupChecks();

  logStartupReport(report);

  if (report.blockStartup) {
    throw new StartupCheckError(report);
  }

  return report;
}