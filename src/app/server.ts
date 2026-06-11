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

const app = createApp();

let tradingWorkersRunning = false;

async function runTradingWorkers() {
  if (tradingWorkersRunning) {
    logger.debug('Trading worker tick skipped because previous tick is still running.');
    return;
  }

  tradingWorkersRunning = true;

  try {
    await processPendingOrders();
    await syncSubmittedOrders();
    await syncTrackedPositions();
    await evaluateExits();
  } catch (error) {
    logger.error({ error }, 'Trading worker loop error.');
  } finally {
    tradingWorkersRunning = false;
  }
}

function startWorkers() {
  // Account snapshot checkpoints do not need the high-frequency trading loop.
  // This checks once per minute and records only scheduled checkpoint snapshots.
  setInterval(() => {
    runScheduledAccountSnapshots().catch((error) => {
      logger.error({ error }, 'Scheduled account snapshot error.');
    });
  }, 60_000);

  // Broker activity sync writes only new/updated broker-confirmed activities.
  // It is intentionally separate from account snapshots.
  setInterval(() => {
    runBrokerActivitySync().catch((error) => {
      logger.error({ error }, 'Broker activity sync error.');
    });
  }, 60_000);

  // Fast operational trading loop.
  setInterval(() => {
    runTradingWorkers().catch((error) => {
      logger.error({ error }, 'Trading worker interval error.');
    });
  }, 2_000);

  // Reconciliation checks are internally gated by runtime settings and
  // de-duped before creating SystemEvents.
  setInterval(() => {
    runScheduledReconciliation().catch((error) => {
      logger.error({ error }, 'Scheduled reconciliation error.');
    });
  }, 60_000);
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