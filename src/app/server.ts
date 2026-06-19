import { createApp } from './app.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
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

const app = createApp();

let tradingWorkersRunning = false;

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

      return {
        outcome: result.found > 0 ? 'success' : 'idle',
        workSucceeded: result.synced > 0,
      };
    });

    await runWorker('tracked_position_sync', async () => {
      await syncTrackedPositions();

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
}

async function startServer() {
  await assertStartupSafe();

  app.listen(env.PORT, () => {
    logger.info(`AI Trader Backend listening on http://localhost:${env.PORT}`);
  });

  startWorkers();
}

startServer().catch((error) => {
  logger.fatal({ error }, 'AI Trader Backend failed startup checks.');
  process.exit(1);
});
