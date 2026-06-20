import { createApp } from './app.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { Server } from 'node:http';
import { AlpacaRateLimitDeferredError } from '../errors/alpaca-rate-limit-deferred-error.js';
import {
  processPendingOrders,
  syncSubmittedOrders,
} from '../workers/order.worker.js';
import { syncTrackedPositions } from '../services/position-tracking.service.js';
import { evaluateExits } from '../services/exit-evaluator.service.js';
import { runScheduledAccountSnapshots } from '../workers/account-snapshot.worker.js';
import { runBrokerActivitySync } from '../workers/broker-activity.worker.js';
import { assertStartupSafe } from '../services/startup-check.service.js';
import { runScheduledReconciliation } from '../workers/reconciliation.worker.js';
import {
  ALPACA_API_USAGE_PERSISTENCE_INTERVAL_MS,
  ACCOUNT_SNAPSHOT_WORKER_INTERVAL_MS,
  BROKER_ACTIVITY_WORKER_INTERVAL_MS,
  RECONCILIATION_SCHEDULER_INTERVAL_MS,
  TRADING_WORKER_INTERVAL_MS,
  type WorkerKey,
} from '../workers/worker-health.definitions.js';
import {
  type WorkerTickResult,
  workerHealthRegistry,
} from '../services/worker-health.service.js';
import { getRuntimeTradingConfig } from '../services/config.service.js';
import { runAlpacaApiUsagePersistence } from '../services/alpaca-api-usage-persistence.service.js';

const app = createApp();

let tradingWorkersRunning = false;
let server: Server | null = null;

function logWorkerError(key: WorkerKey, error: unknown) {
  logger.error({ error, workerKey: key }, 'Worker tick failed.');
}

function skipTradingWorkerTicks(reason: 'already_running') {
  const keys: WorkerKey[] = [
    'pending_order_processing',
    'submitted_order_sync',
    'tracked_position_sync',
    'exit_evaluation',
  ];

  for (const key of keys) {
    workerHealthRegistry.skipWorkerTick(key, reason);
  }
}

async function runWorker(
  key: WorkerKey,
  execute: () => Promise<WorkerTickResult | void>,
  options: { enabled?: boolean } = {}
) {
  try {
    await workerHealthRegistry.runMonitoredWorker(key, execute, options);
  } catch (error) {
    logWorkerError(key, error);
  }
}

async function runTradingWorkers() {
  if (tradingWorkersRunning) {
    logger.debug('Trading worker tick skipped because previous tick is still running.');
    skipTradingWorkerTicks('already_running');
    return;
  }

  tradingWorkersRunning = true;

  try {
    await runWorker('pending_order_processing', async () => {
      const result = await processPendingOrders();

      return {
        outcome: result.found > 0 ? 'success' : 'idle',
        workSucceeded: result.processed > 0,
      };
    });

    await runWorker('submitted_order_sync', async () => {
      const result = await syncSubmittedOrders();

      if (result.deferred) {
        return {
          outcome: 'skipped',
          skipReason: 'not_due',
        };
      }

      return {
        outcome: result.found > 0 ? 'success' : 'idle',
        workSucceeded: result.synced > 0,
      };
    });

    await runWorker('tracked_position_sync', async () => {
      try {
        await syncTrackedPositions();
      } catch (error) {
        if (error instanceof AlpacaRateLimitDeferredError) {
          return {
            outcome: 'skipped',
            skipReason: 'not_due',
          };
        }

        throw error;
      }

      return {
        outcome: 'success',
      };
    });

    await runWorker('exit_evaluation', async () => {
      await evaluateExits();

      return {
        outcome: 'success',
      };
    });
  } finally {
    tradingWorkersRunning = false;
  }
}

function startWorkers() {
  workerHealthRegistry.startPersistence();

  // Account snapshot checkpoints do not need the high-frequency trading loop.
  // This checks once per minute and records only scheduled checkpoint snapshots.
  setInterval(() => {
    void runWorker('account_snapshot_scheduler', async () => {
      const result = await runScheduledAccountSnapshots();

      if (!result.due) {
        return {
          outcome: 'skipped',
          skipReason: 'not_due',
        };
      }

      return {
        outcome: 'success',
        workSucceeded: result.recorded > 0,
      };
    });
  }, ACCOUNT_SNAPSHOT_WORKER_INTERVAL_MS);

  // Broker activity sync writes only new/updated broker-confirmed activities.
  // It is intentionally separate from account snapshots.
  setInterval(() => {
    void runWorker('broker_activity_sync', async () => {
      const result = await runBrokerActivitySync();

      if (result.skipped && result.reason) {
        return {
          outcome: 'skipped',
          skipReason: result.reason,
        };
      }

      if (!result.result) {
        return {
          outcome: 'idle',
        };
      }

      return {
        outcome: result.result.seen > 0 ? 'success' : 'idle',
        workSucceeded: result.result.created > 0 || result.result.updated > 0,
      };
    });
  }, BROKER_ACTIVITY_WORKER_INTERVAL_MS);

  // Fast operational trading loop.
  setInterval(() => {
    void runTradingWorkers().catch((error) => {
      logger.error({ error }, 'Trading worker interval error.');
    });
  }, TRADING_WORKER_INTERVAL_MS);

  // Reconciliation checks are internally gated by runtime settings and
  // de-duped before creating SystemEvents.
  setInterval(() => {
    void (async () => {
      const config = await getRuntimeTradingConfig();

      await runWorker(
        'scheduled_reconciliation',
        async () => {
          const result = await runScheduledReconciliation();

          if (result.skipped && result.reason) {
            return {
              outcome: 'skipped',
              skipReason: result.reason,
            };
          }

          if (!result.result) {
            return {
              outcome: 'idle',
            };
          }

          return {
            outcome: 'success',
            workSucceeded: result.result.findings.length > 0,
          };
        },
        { enabled: config.reconciliationWorkerEnabled }
      );
    })().catch((error) => {
      logger.error({ error }, 'Scheduled reconciliation wrapper error.');
    });
  }, RECONCILIATION_SCHEDULER_INTERVAL_MS);

  // Observability persistence is intentionally separate from broker-facing
  // trading workers. Failures here should affect only this worker's health.
  setInterval(() => {
    void runWorker('alpaca_api_usage_persistence', async () => {
      const result = await runAlpacaApiUsagePersistence();

      if (result.flushedAggregateCount === 0 && !result.retentionDue) {
        return {
          outcome: 'idle',
        };
      }

      if (result.flushedAggregateCount === 0 && result.retentionDue) {
        return {
          outcome: 'skipped',
          skipReason: 'not_due',
        };
      }

      return {
        outcome: 'success',
        workSucceeded:
          result.flushedAggregateCount > 0 ||
          result.retentionDeletedCount > 0,
      };
    });
  }, ALPACA_API_USAGE_PERSISTENCE_INTERVAL_MS);
}

async function startServer() {
  await assertStartupSafe();

  server = app.listen(env.PORT, () => {
    logger.info(`AI Trader Backend listening on http://localhost:${env.PORT}`);
  });

  startWorkers();
}

async function shutdown(signal: NodeJS.Signals) {
  logger.info({ signal }, 'AI Trader Backend shutdown requested.');

  workerHealthRegistry.stopPersistence();

  await Promise.race([
    workerHealthRegistry.shutdown(),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);

  if (server) {
    server.close(() => {
      logger.info('AI Trader Backend HTTP server closed.');
      process.exit(0);
    });

    setTimeout(() => {
      logger.warn('Timed out waiting for HTTP server close.');
      process.exit(0);
    }, 5_000).unref();

    return;
  }

  process.exit(0);
}

process.once('SIGINT', (signal) => {
  void shutdown(signal);
});

process.once('SIGTERM', (signal) => {
  void shutdown(signal);
});

startServer().catch((error) => {
  logger.fatal({ error }, 'AI Trader Backend failed startup checks.');
  process.exit(1);
});
