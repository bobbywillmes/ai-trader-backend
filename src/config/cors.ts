import type { CorsOptions } from 'cors';
import { env } from './env.js';
import { logger } from './logger.js';

function parseAllowedOrigins(value: string) {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const allowedCorsOrigins = parseAllowedOrigins(
  env.CORS_ALLOWED_ORIGINS
);

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Allow non-browser/server-to-server requests that do not send Origin.
    // API-key/JWT auth still protects protected routes.
    if (!origin) {
      callback(null, true);
      return;
    }

    if (allowedCorsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    logger.warn(
      {
        origin,
        allowedCorsOrigins,
      },
      'Blocked request from disallowed CORS origin.'
    );

    callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
};