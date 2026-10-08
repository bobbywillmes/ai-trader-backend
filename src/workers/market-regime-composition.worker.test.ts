import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('../services/market-regime-composition-publication.service.js', () => ({ publishMarketRegimeComposition: mocks.publish }));
import { runMarketRegimeCompositionWorker } from './market-regime-composition.worker.js';
import { getWorkerDefinition, MARKET_REGIME_COMPOSITION_WORKER_INTERVAL_MS } from './worker-health.definitions.js';

beforeEach(() => vi.clearAllMocks());
describe('Market Regime composition worker', () => {
  it('is informational, bounded and reports new immutable publication as useful work', async () => {
    expect(MARKET_REGIME_COMPOSITION_WORKER_INTERVAL_MS).toBe(60_000);
    expect(getWorkerDefinition('market_regime_composition_publication')).toMatchObject({ criticality: 'informational', enabledByDefault: true });
    mocks.publish.mockResolvedValue({ published: true, reused: false });
    await expect(runMarketRegimeCompositionWorker()).resolves.toEqual({ outcome: 'success', workSucceeded: true });
  });

  it('treats repeated scheduler ticks as idempotent no-work', async () => {
    mocks.publish.mockResolvedValue({ published: false, reused: true });
    await expect(runMarketRegimeCompositionWorker()).resolves.toEqual({ outcome: 'skipped', skipReason: 'not_due', workSucceeded: false });
  });
});
