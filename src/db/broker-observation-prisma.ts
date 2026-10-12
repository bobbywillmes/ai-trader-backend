import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { env } from '../config/env.js';

export const BROKER_OBSERVATION_POOL_MAX = env.BROKER_OBSERVATION_POOL_MAX;
export const BROKER_OBSERVATION_CONNECTION_TIMEOUT_MS = 50;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: BROKER_OBSERVATION_POOL_MAX,
  connectionTimeoutMillis: BROKER_OBSERVATION_CONNECTION_TIMEOUT_MS,
});

const adapter = new PrismaPg(pool, { disposeExternalPool: true });

export const brokerObservationPrisma = new PrismaClient({ adapter });

let closing: Promise<void> | null = null;

export function closeBrokerObservationPrisma() {
  closing ??= brokerObservationPrisma.$disconnect();
  return closing;
}
