import { AlpacaRateLimitDeferredError } from '../errors/alpaca-rate-limit-deferred-error.js';
import { syncBrokerActivitiesForAccount } from '../services/broker-activity.service.js';
import { enumerateLifecycleAccounts } from '../services/lifecycle-account-eligibility.service.js';
import { runTradingAccountWorkflow } from '../services/trading-account-workflow-runner.service.js';
import { ACCOUNT_WORKFLOW_LOCK_FAMILIES } from '../services/trading-account-workflow-lock.service.js';

let running = false;

export async function runBrokerActivitySync() {
  if (running) {
    return {
      skipped: true,
      reason: 'already_running' as const,
    };
  }

  running = true;

  try {
    const accounts = await enumerateLifecycleAccounts('broker_activities');
    const results = [];

    for (const account of accounts) {
      if (!account.eligible) {
        results.push({
          account,
          outcome:
            account.reason === 'credentials_unavailable_with_exposure'
              ? 'CREDENTIALS_UNAVAILABLE' as const
              : 'SKIPPED' as const,
        });
        continue;
      }

      try {
        const run = await runTradingAccountWorkflow({
          tradingAccountId: account.tradingAccountId,
          workerKey: 'broker_activity_sync',
          lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.BROKER_ACTIVITY,
          execute: () => syncBrokerActivitiesForAccount(account.tradingAccountId, {
            activityType: 'FILL',
            pageSize: 100,
            maxPages: 3,
          }),
        });
        if (run.outcome === 'FAILED') throw run.error;
        if (run.outcome === 'PROCESSED') {
          results.push({ account, outcome: 'PROCESSED' as const, result: run.value });
        } else {
          results.push({ account, outcome: 'SKIPPED' as const,
            deferred: run.outcome === 'BACKING_OFF',
            backoffUntil: run.outcome === 'BACKING_OFF' ? run.backoffUntil.toISOString() : null });
        }
      } catch (error) {
        if (error instanceof AlpacaRateLimitDeferredError) {
          results.push({
            account,
            outcome: 'SKIPPED' as const,
            deferred: true,
            backoffUntil: error.backoffUntil?.toISOString() ?? null,
          });
          continue;
        }

        const message =
          error instanceof Error ? error.message : 'Unknown worker error.';
        results.push({ account, outcome: 'FAILED' as const, error: message });
        console.error({
          workflow: 'broker_activities',
          tradingAccountId: account.tradingAccountId,
          displayName: account.displayName,
          environment: account.environment,
          outcome: 'FAILED',
          error: message,
        });
      }
    }

    return {
      skipped: false,
      results,
      processedAccounts: results.filter(
        (item) => item.outcome === 'PROCESSED'
      ).length,
      failedAccounts: results.filter((item) => item.outcome === 'FAILED')
        .length,
    };
  } finally {
    running = false;
  }
}
