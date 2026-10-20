import { prisma } from '../db/prisma.js';
import { assessPaperBrokerWriteAuthority } from './paper-broker-write-authority.service.js';

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
    paperBrokerWriteAuthority: await (async () => {
      try {
        const result = await assessPaperBrokerWriteAuthority();
        const required = result.accounts.filter(item => item.intendedExecutor || (process.env.NODE_ENV === 'production' && item.openLifecycleExposure));
        return { configurationValid: result.configuration.ready, verifiedExecutorCoverage: result.ready ? 'READY' as const : 'NOT_READY' as const,
          requiredExecutorCount: required.length, authorizedExecutorCount: required.filter(item => item.outcome === 'AUTHORIZED').length };
      } catch { return { configurationValid: false, verifiedExecutorCoverage: 'UNKNOWN' as const, requiredExecutorCount: 0, authorizedExecutorCount: 0 }; }
    })(),
    timestamp: new Date().toISOString(),
  };
}
