import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock('../services/order-intent-market-policy-comparison.service.js', () => ({ processOrderIntentMarketPolicyComparisons: mocks.process }));
import { runOrderIntentMarketPolicyComparisonWorker } from './order-intent-market-policy-comparison.worker.js';
import { getWorkerDefinition } from './worker-health.definitions.js';

describe('OrderIntent market-policy comparison worker', () => {
  beforeEach(() => mocks.process.mockReset());
  it('is disabled by default', () => expect(getWorkerDefinition('order_intent_market_policy_comparison').enabledByDefault).toBe(false));
  it('reports disabled and idle without trading work', async () => {
    mocks.process.mockResolvedValueOnce({ enabled: false, seeded: 0, claimed: 0, completed: 0, retrying: 0, terminalFailures: 0 });
    await expect(runOrderIntentMarketPolicyComparisonWorker()).resolves.toMatchObject({ outcome: 'skipped', skipReason: 'disabled' });
    mocks.process.mockResolvedValueOnce({ enabled: true, seeded: 0, claimed: 0, completed: 0, retrying: 0, terminalFailures: 0 });
    await expect(runOrderIntentMarketPolicyComparisonWorker()).resolves.toMatchObject({ outcome: 'skipped', skipReason: 'not_due' });
  });
  it('surfaces durable terminal failures through worker health', async () => {
    mocks.process.mockResolvedValue({ enabled: true, seeded: 0, claimed: 1, completed: 0, retrying: 0, terminalFailures: 1 });
    await expect(runOrderIntentMarketPolicyComparisonWorker()).rejects.toThrow('TERMINAL_FAILURE:1');
  });
});
