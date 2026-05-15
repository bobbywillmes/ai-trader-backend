import { createApp } from './app.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { processPendingOrders, syncSubmittedOrders } from '../workers/order.worker.js';
import { syncTrackedPositions } from '../services/position-tracking.service.js';
import { evaluateExits } from '../services/exit-evaluator.service.js';
import { runScheduledAccountSnapshots } from '../workers/account-snapshot.worker.js';
import { runBrokerActivitySync } from '../workers/broker-activity.worker.js';

const app = createApp();

app.listen(env.PORT, () => {
  logger.info(`AI Trader Backend listening on http://localhost:${env.PORT}`);
});

// Account snapshot checkpoints do not need the high-frequency trading loop.
// This checks once per minute and records only scheduled checkpoint snapshots.
setInterval(() => {
  runScheduledAccountSnapshots().catch((error) => {
    console.error('Scheduled account snapshot error:', error);
  });
}, 60_000);

// Broker activity sync writes only new/updated broker-confirmed activities.
// It is intentionally separate from account snapshots.
setInterval(() => {
  runBrokerActivitySync().catch((error) => {
    console.error('Broker activity sync error:', error);
  });
}, 60_000);

let tradingWorkersRunning = false;

async function runTradingWorkers() {
  if (tradingWorkersRunning) {
    console.log('Trading worker tick skipped because previous tick is still running.');
    return;
  }

  tradingWorkersRunning = true;

  // Start the order processing worker loop
  try {
    await processPendingOrders();
    await syncSubmittedOrders();
    await syncTrackedPositions();
    await evaluateExits();
  } catch (error) {
    console.error('Trading worker loop error:', error);
  } finally {
    tradingWorkersRunning = false;
  }
}

setInterval(() => {
  runTradingWorkers().catch((error) => {
    console.error('Trading worker interval error:', error);
  });
}, 2_000);