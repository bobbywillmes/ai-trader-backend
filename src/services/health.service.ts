import { prisma } from '../db/prisma.js';
import { getPaperBrokerWriteAuthorityStatus } from './paper-broker-write-authority.service.js';

export type HealthStatus = {
  ok: boolean;
  service: string;
  environment: string;
  uptimeSeconds: number;
  database: {
    ok: boolean;
    message: string;
  };
  paperBrokerWriteAuthority: { configurationValid: boolean; verifiedExecutorCoverage: 'READY' | 'NOT_READY' | 'UNKNOWN'; requiredExecutorCount: number; authorizedExecutorCount: number };
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
    paperBrokerWriteAuthority: (() => {
      const configuration = getPaperBrokerWriteAuthorityStatus();
      return { configurationValid: configuration.configurationValid, verifiedExecutorCoverage: 'UNKNOWN' as const,
        requiredExecutorCount: configuration.expectedExecutorCount, authorizedExecutorCount: 0 };
    })(),
    timestamp: new Date().toISOString(),
  };
}
