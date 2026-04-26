import { createApp } from './app.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { processPendingOrders } from '../workers/order.worker.js';

const app = createApp();

app.listen(env.PORT, () => {
  logger.info(`AI Trader Backend listening on http://localhost:${env.PORT}`);
});

// Start the order processing worker loop
setInterval(() => {
  processPendingOrders().catch((error) => {
    console.error('Order worker error:', error);
  });
}, 2000);