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

// Start the order processing worker loop
setInterval(() => {
  processPendingOrders().catch((error) => {
    console.error('Order worker error:', error);
  });
  syncSubmittedOrders().catch((error) => {
    console.error('Sync submitted orders error:', error);
  });
  syncTrackedPositions().catch((error) => {
    console.error('Position sync error:', error);
  });
  evaluateExits().catch((error) => {
    console.error('Exit evaluation error:', error);
  });
}, 2000);