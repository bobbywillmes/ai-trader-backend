import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { logger } from '../config/logger.js';

import healthRoutes from '../routes/health.routes.js';
import bootstrapRoutes from '../routes/bootstrap.routes.js';
import accountRoutes from '../routes/account.routes.js';
import positionsRoutes from '../routes/positions.routes.js';
import ordersRoutes from '../routes/orders.routes.js';
import orderIntentsRoutes from '../routes/order-intents.routes.js';
import configRoutes from '../routes/config.routes.js';
import systemEventsRoutes from '../routes/system-events.routes.js';
import trackedPositionsRoutes from '../routes/tracked-positions.routes.js';
import strategiesRoutes from '../routes/strategies.routes.js';
import exitProfilesRoutes from '../routes/exit-profiles.routes.js';
import subscriptionsRoutes from '../routes/subscriptions.routes.js';
import signalsRoutes from '../routes/signals.routes.js';
import { openTrackedPositionsController } from '../controllers/tracked-positions.controller.js';
import adminAuthRoutes from '../routes/admin-auth.routes.js';

import { notFoundHandler } from '../middleware/not-found.js';
import { errorHandler } from '../middleware/error-handler.js';
import { requireSignalApiKey, requireAdminAccess } from '../middleware/api-key-auth.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.use(
    pinoHttp({
      logger
    })
  );

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      service: 'ai-trader-backend'
    });
  });

  app.use('/health', healthRoutes);
  
  // Admin auth routes
  app.use('/api/admin-auth', adminAuthRoutes);

  // Client / n8n signal routes
  app.use('/api/signals', requireSignalApiKey, signalsRoutes);
  app.get('/api/tracked-positions/open', requireSignalApiKey, openTrackedPositionsController
  );

  // Admin routes
  app.use('/api/bootstrap', requireAdminAccess, bootstrapRoutes);
  app.use('/api/account', requireAdminAccess, accountRoutes);
  app.use('/api/positions', requireAdminAccess, positionsRoutes);
  app.use('/api/orders', requireAdminAccess, ordersRoutes);
  app.use('/api/order-intents', requireAdminAccess, orderIntentsRoutes);
  app.use('/api/system-events', requireAdminAccess, systemEventsRoutes);
  app.use('/api/tracked-positions', requireAdminAccess, trackedPositionsRoutes);
  app.use('/api/config', requireAdminAccess, configRoutes);
  app.use('/api/strategies', requireAdminAccess, strategiesRoutes);
  app.use('/api/exit-profiles', requireAdminAccess, exitProfilesRoutes);
  app.use('/api/subscriptions', requireAdminAccess, subscriptionsRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}