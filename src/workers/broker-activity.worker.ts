import { syncBrokerActivities } from '../services/broker-activity.service.js';

let running = false;

export async function runBrokerActivitySync() {
  if (running) {
    return;
  }

  running = true;

  try {
    await syncBrokerActivities({
      activityType: 'FILL',
      pageSize: 100,
      maxPages: 3,
    });
  } finally {
    running = false;
  }
}