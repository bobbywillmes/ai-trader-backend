import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getRuntimeTradingConfig } from './config.service.js';
import { allowedCorsOrigins } from '../config/cors.js';
import { isIsolatedManualAcceptanceEnvironment } from './manual-acceptance-environment.js';

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

export function logStartupReport(report: StartupCheckReport) {
  const passed = report.checks.filter((check) => check.status === 'pass');
  const warnings = report.checks.filter((check) => check.status === 'warn');
  const failures = report.checks.filter((check) => check.status === 'fail');
  const runtimeConfig = report.checks.find(
    (check) => check.name === 'runtime_config' && check.status === 'pass'
  )?.details;
  const tradingEnabled = runtimeConfig?.tradingEnabled === true;
  const killSwitchEnabled = runtimeConfig?.killSwitchEnabled === true;
  const databaseConnected = report.checks.some(
    (check) => check.name === 'database' && check.status === 'pass'
  );
  const statusParts = [
    report.environment,
    databaseConnected ? 'database connected' : 'database unavailable',
    killSwitchEnabled
      ? 'kill switch enabled'
      : tradingEnabled
        ? 'entry trading enabled'
        : 'entry trading disabled',
    `${passed.length} checks passed`,
    `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
    `http://localhost:${env.PORT}`,
  ];
  if (report.blockStartup) {
    logger.error(
      `AI Trader Backend startup blocked: ${statusParts.join(' | ')} | ` +
        `${failures.length} failed (${failures.map((check) => check.name).join(', ')})`
    );
  } else if (warnings.length > 0) {
    logger.info(`AI Trader Backend ready: ${statusParts.join(' | ')}`);
    logger.warn(`Warnings: ${warnings.map((check) => check.message).join(' | ')}`);
  } else {
    logger.info(`AI Trader Backend ready: ${statusParts.join(' |')}`);
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

    checks.push(
      warn(
        'legacy_global_broker_mode',
        'ALPACA_BASE_URL and global paperMode are compatibility settings only. TradingAccount.environment controls broker routing.',
        {
          paperMode: config.paperMode,
          legacyAlpacaBaseUrlIsPaper: usingPaperBrokerUrl,
        }
      )
    );

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

    const isolatedManualAcceptance =
      isProduction &&
      isIsolatedManualAcceptanceEnvironment({
        sentinel: process.env.MANUAL_ACCEPTANCE_HARNESS,
        entrypoint: process.env.MANUAL_ACCEPTANCE_ENTRYPOINT,
        databaseUrl: env.DATABASE_URL,
        allowedOrigins: allowedCorsOrigins,
      });

    if (
      isProduction &&
      allowedCorsOrigins.some(isLocalhostOrigin) &&
      !isolatedManualAcceptance
    ) {
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

    if (
      isProduction &&
      allowedCorsOrigins.some(isLocalhostOrigin) &&
      isolatedManualAcceptance
    ) {
      checks.push(
        pass(
          'manual_acceptance_localhost_cors_origin',
          'Exact loopback UI origin accepted for the isolated manual-acceptance harness.',
          { allowedCorsOrigins }
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

    if (isProduction && config.tradingEnabled) {
      checks.push(
        pass(
          'production_global_entry_trading_enabled_on_start',
          'Production startup found global entry trading enabled. Account environment and LIVE-write permission are enforced per Trading Account.',
          {
            source: 'Setting table',
            tradingEnabled: config.tradingEnabled,
            paperMode: config.paperMode,
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

export async function assertStartupSafe(options: { logSuccess?: boolean } = {}) {
  const report = await runStartupChecks();

  if (report.blockStartup) {
    logStartupReport(report);
    throw new StartupCheckError(report);
  }

  if (options.logSuccess !== false) {
    logStartupReport(report);
  }

  return report;
}
