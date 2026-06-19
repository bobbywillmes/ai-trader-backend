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
    const result = await syncBrokerActivities({
      activityType: 'FILL',
      pageSize: 100,
      maxPages: 3,
    });

    return {
      skipped: false,
      result,
    };
  } finally {
    running = false;
  }
}
