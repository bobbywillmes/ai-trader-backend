import { prisma } from '../db/prisma.js';

export type HealthStatus = {
  ok: boolean;
  service: string;
  environment: string;
  uptimeSeconds: number;
  database: {
    ok: boolean;
    message: string;
  };
  timestamp: string;
};

export async function getHealthStatus(): Promise<HealthStatus> {
  let databaseOk = false;
  let databaseMessage = 'Database check failed.';

  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseOk = true;
    databaseMessage = 'Database reachable.';
  } catch (error) {
    databaseMessage =
      error instanceof Error ? error.message : 'Unknown database error.';
  }

  return {
    ok: databaseOk,
    service: 'ai-trader-backend',
    environment: process.env.NODE_ENV ?? 'unknown',
    uptimeSeconds: Math.round(process.uptime()),
    database: {
      ok: databaseOk,
      message: databaseMessage,
    },
    timestamp: new Date().toISOString(),
  };
}