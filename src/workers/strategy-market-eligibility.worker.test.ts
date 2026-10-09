import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock('../services/strategy-market-eligibility.service.js', () => ({ evaluateActiveStrategyPolicies: mocks.evaluate }));
import { runStrategyMarketEligibilityWorker } from './strategy-market-eligibility.worker.js';

describe('strategy market eligibility worker', () => {
  beforeEach(() => vi.clearAllMocks());
  it('reports bounded idle recovery when no active policies exist', async () => { mocks.evaluate.mockResolvedValue({ evaluated: 0, createdOrReused: 0 }); await expect(runStrategyMarketEligibilityWorker()).resolves.toEqual({ outcome: 'skipped', skipReason: 'not_due', workSucceeded: false }); });
  it('reports successful shadow evaluation without invoking trading services', async () => { mocks.evaluate.mockResolvedValue({ evaluated: 2, createdOrReused: 2 }); await expect(runStrategyMarketEligibilityWorker()).resolves.toEqual({ outcome: 'success', workSucceeded: true }); expect(mocks.evaluate).toHaveBeenCalledOnce(); });
});
