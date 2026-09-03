import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 8 });
const APP_NAMESPACE = 'ai-trader';

export const ACCOUNT_WORKFLOW_LOCK_FAMILIES = {
  // Shared barrier for writers/readers whose lifecycle conclusions overlap.
  // Each account acquires this one key, so no nested lock ordering is needed.
  LIFECYCLE_MUTATION: 'lifecycle-mutation',
  ORDER_LIFECYCLE: 'order-lifecycle',
  BROKER_ACTIVITY: 'broker-activity',
  POSITION_SYNC: 'position-sync',
  EXIT_EVALUATION: 'exit-evaluation',
  EXIT_SUBMISSION: 'exit-submission',
  RECONCILIATION: 'reconciliation',
  ACCOUNT_SNAPSHOT: 'account-snapshot',
  READINESS_ASSESSMENT: 'readiness-assessment',
  OPERATIONAL_STATE: 'operational-state',
} as const;

export type AccountWorkflowLockResult<T> =
  | { outcome: 'ACQUIRED_AND_COMPLETED'; value: T; scope: string }
  | { outcome: 'NOT_ACQUIRED'; scope: string }
  | { outcome: 'LOCK_ERROR'; error: unknown; scope: string }
  | { outcome: 'WORKFLOW_ERROR'; error: unknown; scope: string };

export function deriveAdvisoryLockKey(scope: string): bigint {
  const bytes = createHash('sha256').update(scope).digest().subarray(0, 8);
  return bytes.readBigInt64BE(0);
}

export async function withTradingAccountWorkflowLock<T>(args: {
  tradingAccountId: number;
  workflowKey: string;
  processInstanceId: string;
  execute: () => Promise<T>;
}): Promise<AccountWorkflowLockResult<T>> {
  if (!Number.isInteger(args.tradingAccountId) || args.tradingAccountId <= 0) {
    throw new Error(
      'A real positive tradingAccountId is required for an advisory lock.',
    );
  }
  const scope = `${APP_NAMESPACE}:${args.workflowKey}:${args.tradingAccountId}`;
  const key = deriveAdvisoryLockKey(scope);
  let client;
  let acquired = false;
  const startedAt = Date.now();
  try {
    client = await pool.connect();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [key.toString()],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) {
      logger.trace(
        {
          scope,
          tradingAccountId: args.tradingAccountId,
          workflow: args.workflowKey,
          processInstanceId: args.processInstanceId,
        },
        'Account workflow lock skipped.',
      );
      return { outcome: 'NOT_ACQUIRED', scope };
    }
    logger.trace(
      {
        scope,
        tradingAccountId: args.tradingAccountId,
        workflow: args.workflowKey,
        processInstanceId: args.processInstanceId,
      },
      'Account workflow lock acquired.',
    );
    try {
      return {
        outcome: 'ACQUIRED_AND_COMPLETED',
        value: await args.execute(),
        scope,
      };
    } catch (error) {
      return { outcome: 'WORKFLOW_ERROR', error, scope };
    }
  } catch (error) {
    logger.trace(
      {
        error,
        scope,
        tradingAccountId: args.tradingAccountId,
        workflow: args.workflowKey,
        processInstanceId: args.processInstanceId,
      },
      'Account workflow lock acquisition failed before account health persistence.',
    );
    return { outcome: 'LOCK_ERROR', error, scope };
  } finally {
    if (client) {
      if (acquired) {
        try {
          await client.query('SELECT pg_advisory_unlock($1::bigint)', [
            key.toString(),
          ]);
          logger.trace(
            { scope, durationMs: Date.now() - startedAt },
            'Account workflow lock released.',
          );
        } catch (error) {
          logger.error(
            { error, scope },
            'Account workflow lock release failed.',
          );
        }
      }
      client.release();
    }
  }
}

export async function closeTradingAccountWorkflowLockPool() {
  await pool.end();
}
