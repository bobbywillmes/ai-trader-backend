import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateBreadthV1BootstrapArtifact } from './breadth-v1-bootstrap-artifact-generator.js';
import { writeCached } from './breadth-research-cache.js';

let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(path.join(os.tmpdir(), 'breadth-bootstrap-artifact-test-')); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

async function seed() {
  // 2024-01-02 is the previous-session boundary for the first universe session, 2024-01-03.
  await writeCached(cacheDir, 'grouped', '2024-01-02', { ok: true, value: { A: 100, B: 100, C: 100 } });
  await writeCached(cacheDir, 'grouped', '2024-01-03', { ok: true, value: { A: 110, B: 90, C: 100 } });
  await writeCached(cacheDir, 'grouped', '2024-01-04', { ok: false, error: 'entitlement gap' });
  await writeCached(cacheDir, 'universe', '2024-01-03', { ok: true, value: ['A', 'B', 'C'] });
  await writeCached(cacheDir, 'universe', '2024-01-04', { ok: true, value: ['A', 'B', 'C'] });
}

describe('BREADTH_V1 bootstrap artifact generator (zero provider calls)', () => {
  it('derives correct counts/hashes from cache and skips a resolved provider-failure date without a fabricated row', async () => {
    await seed();
    const artifact = await generateBreadthV1BootstrapArtifact(cacheDir);
    expect(artifact.rowCount).toBe(1); // 2024-01-04's grouped read failed; no row for it.
    expect(artifact.rows).toHaveLength(1);
    const row = artifact.rows[0]!;
    expect(row).toMatchObject({ sessionDate: '2024-01-03', previousSessionDate: '2024-01-02', advancingCount: 1, decliningCount: 1, unchangedCount: 1, directionalCount: 2, universeCount: 3 });
    expect(row.canonicalInputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.canonicalArtifactHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is fully deterministic: rerunning against the same cache produces a byte-identical hash', async () => {
    await seed();
    const first = await generateBreadthV1BootstrapArtifact(cacheDir);
    const second = await generateBreadthV1BootstrapArtifact(cacheDir);
    expect(second.canonicalArtifactHash).toBe(first.canonicalArtifactHash);
    expect(second).toEqual(first);
  });

  it('never produces a row for a zero-directional (all-unchanged) session', async () => {
    await writeCached(cacheDir, 'grouped', '2024-01-02', { ok: true, value: { A: 100 } });
    await writeCached(cacheDir, 'grouped', '2024-01-03', { ok: true, value: { A: 100 } }); // Unchanged only.
    await writeCached(cacheDir, 'universe', '2024-01-03', { ok: true, value: ['A'] });
    await expect(generateBreadthV1BootstrapArtifact(cacheDir)).rejects.toThrow('No valid observations could be derived from the cache');
  });

  it('STOPs when the cache is missing entirely rather than fetching anything', async () => {
    await expect(generateBreadthV1BootstrapArtifact(cacheDir)).rejects.toThrow('No cached Breadth universe evidence found');
  });
});
