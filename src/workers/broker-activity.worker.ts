import { AlpacaRateLimitDeferredError } from '../errors/alpaca-rate-limit-deferred-error.js';
import { syncBrokerActivities } from '../services/broker-activity.service.js';

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
    let result: Awaited<ReturnType<typeof syncBrokerActivities>>;

    try {
      result = await syncBrokerActivities({
        activityType: 'FILL',
        pageSize: 100,
        maxPages: 3,
      });
    } catch (error) {
      if (error instanceof AlpacaRateLimitDeferredError) {
        return {
          skipped: true,
          reason: 'not_due' as const,
          deferred: true,
          backoffUntil: error.backoffUntil?.toISOString() ?? null,
        };
      }

      throw error;
    }

    return {
      skipped: false,
      result,
    };
  } finally {
    running = false;
  }
}
