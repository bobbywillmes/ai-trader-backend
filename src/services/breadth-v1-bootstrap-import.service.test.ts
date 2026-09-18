import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { generateBreadthV1BootstrapArtifact, type BreadthV1BootstrapArtifact } from '../dev/breadth-v1-bootstrap-artifact-generator.js';
import { writeCached } from '../dev/breadth-research-cache.js';
vi.mock('../db/prisma.js', () => ({ prisma: {} }));
import { applyBreadthV1Bootstrap, loadValidatedBreadthV1BootstrapArtifact, previewBreadthV1Bootstrap } from './breadth-v1-bootstrap-import.service.js';

let cacheDir: string;
let artifactPath: string;
let artifact: BreadthV1BootstrapArtifact;
let stored: { id: number; sessionDate: Date; previousSessionDate: Date; universeCount: number; currentBarCount: number; priorBarCount: number; advancingCount: number; decliningCount: number; unchangedCount: number; directionalCount: number; excludedCount: number; advanceShare: Prisma.Decimal; netBreadth: Prisma.Decimal; canonicalInputHash: string }[];
let calendarExceptions: unknown[];
let created: Record<string, unknown>[];

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'breadth-import-test-'));
  artifactPath = path.join(cacheDir, 'artifact.json');
  await writeCached(cacheDir, 'grouped', '2024-01-02', { ok: true, value: { A: 100, B: 100 } });
  await writeCached(cacheDir, 'grouped', '2024-01-03', { ok: true, value: { A: 110, B: 90 } });
  await writeCached(cacheDir, 'grouped', '2024-01-04', { ok: true, value: { A: 90, B: 110 } });
  await writeCached(cacheDir, 'universe', '2024-01-03', { ok: true, value: ['A', 'B'] });
  await writeCached(cacheDir, 'universe', '2024-01-04', { ok: true, value: ['A', 'B'] });
  artifact = await generateBreadthV1BootstrapArtifact(cacheDir);
  await writeFile(artifactPath, JSON.stringify(artifact));
  stored = []; calendarExceptions = []; created = [];
});
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

function makeDb(): PrismaClient {
  const marketBreadthObservation = {
    findMany: vi.fn(async () => stored),
    createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => { created.push(...data); return { count: data.length }; }),
  };
  const tx = { marketBreadthObservation, marketCalendarException: { findMany: vi.fn(async () => calendarExceptions) }, systemEvent: { create: vi.fn(async () => ({})) } };
  return { marketBreadthObservation, $transaction: async (execute: (client: typeof tx) => unknown) => execute(tx) } as unknown as PrismaClient;
}

describe('BREADTH_V1 historical bootstrap import (insert-only, zero provider calls)', () => {
  it('loads and validates a well-formed artifact', async () => {
    const loaded = await loadValidatedBreadthV1BootstrapArtifact(artifactPath);
    expect(loaded.rowCount).toBe(2);
  });
  it('rejects an artifact whose top-level canonicalArtifactHash does not match its content', async () => {
    const tampered = { ...artifact, from: '2020-01-01' };
    await writeFile(artifactPath, JSON.stringify(tampered));
    await expect(loadValidatedBreadthV1BootstrapArtifact(artifactPath)).rejects.toThrow('canonicalArtifactHash');
  });
  it('rejects an artifact with a tampered per-row canonicalInputHash', async () => {
    const tampered = { ...artifact, rows: artifact.rows.map((row, i) => i === 0 ? { ...row, advanceShare: 0.999 } : row) };
    await writeFile(artifactPath, JSON.stringify(tampered));
    await expect(loadValidatedBreadthV1BootstrapArtifact(artifactPath)).rejects.toThrow('canonicalArtifactHash'); // top-level hash breaks first
  });
  it('rejects non-chronological rows', async () => {
    const tampered = { ...artifact, rows: [...artifact.rows].reverse() };
    // Recompute a top-level hash consistent with the reversed rows so only the chronology check fires.
    const { canonicalArtifactHash: _drop, ...withoutHash } = tampered;
    const { createHash } = await import('node:crypto');
    const recomputed = createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex');
    await writeFile(artifactPath, JSON.stringify({ ...withoutHash, canonicalArtifactHash: recomputed }));
    await expect(loadValidatedBreadthV1BootstrapArtifact(artifactPath)).rejects.toThrow('not strictly chronological');
  });
  it('preview makes no writes and reports every row as an insert on an empty database', async () => {
    const preview = await previewBreadthV1Bootstrap({ db: makeDb(), artifactPath });
    expect(preview).toMatchObject({ artifactRows: 2, inserts: 2, existingMatches: 0, conflicts: [] });
    expect(created).toHaveLength(0);
  });
  it('apply inserts missing rows with calendar-derived dataThroughAt, and a rerun is a full no-op', async () => {
    calendarExceptions = [];
    const result = await applyBreadthV1Bootstrap({ db: makeDb(), artifactPath, now: new Date('2026-01-01T00:00Z') });
    expect(result).toMatchObject({ inserted: 2, skipped: 0, conflicts: [] });
    expect(created[0]).toMatchObject({ sessionDate: new Date('2024-01-03'), previousSessionDate: new Date('2024-01-02'), provider: 'MASSIVE' });
    expect(created[0]!.dataThroughAt).toBeInstanceOf(Date);
    // Simulate the rows now existing in the database for the rerun (Decimal columns, as a real read-back would return).
    stored = created.map((row, i) => ({ ...(row as typeof stored[number]), id: i + 1, advanceShare: new Prisma.Decimal((row as { advanceShare: number }).advanceShare), netBreadth: new Prisma.Decimal((row as { netBreadth: number }).netBreadth) }));
    const rerunPreview = await previewBreadthV1Bootstrap({ db: makeDb(), artifactPath });
    expect(rerunPreview).toMatchObject({ inserts: 0, existingMatches: 2, conflicts: [] });
    const rerunApply = await applyBreadthV1Bootstrap({ db: makeDb(), artifactPath, now: new Date('2026-01-01T00:00Z') });
    expect(rerunApply).toMatchObject({ inserted: 0, skipped: 2, conflicts: [] });
  });
  it('fails closed on any conflicting existing row and writes nothing at all', async () => {
    stored = [{
      id: 1, sessionDate: new Date(artifact.rows[0]!.sessionDate), previousSessionDate: new Date(artifact.rows[0]!.previousSessionDate),
      universeCount: 999, currentBarCount: artifact.rows[0]!.currentBarCount, priorBarCount: artifact.rows[0]!.priorBarCount,
      advancingCount: artifact.rows[0]!.advancingCount, decliningCount: artifact.rows[0]!.decliningCount, unchangedCount: artifact.rows[0]!.unchangedCount,
      directionalCount: artifact.rows[0]!.directionalCount, excludedCount: artifact.rows[0]!.excludedCount,
      advanceShare: new Prisma.Decimal(artifact.rows[0]!.advanceShare), netBreadth: new Prisma.Decimal(artifact.rows[0]!.netBreadth),
      canonicalInputHash: artifact.rows[0]!.canonicalInputHash,
    }];
    const preview = await previewBreadthV1Bootstrap({ db: makeDb(), artifactPath });
    expect(preview.conflicts).toEqual([{ sessionDate: artifact.rows[0]!.sessionDate, reason: expect.any(String) }]);
    await expect(applyBreadthV1Bootstrap({ db: makeDb(), artifactPath, now: new Date() })).rejects.toMatchObject({ statusCode: 409 });
    expect(created).toHaveLength(0);
  });
});
