import { createApp } from './app.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { processPendingOrders, syncSubmittedOrders } from '../workers/order.worker.js';
import { syncTrackedPositions } from '../services/position-tracking.service.js';

const app = createApp();

app.listen(env.PORT, () => {
  logger.info(`AI Trader Backend listening on http://localhost:${env.PORT}`);
});

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
}, 2000);