import { createApp } from './app.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const app = createApp();

app.listen(env.PORT, () => {
  logger.info(`AI Trader Backend listening on http://localhost:${env.PORT}`);
});