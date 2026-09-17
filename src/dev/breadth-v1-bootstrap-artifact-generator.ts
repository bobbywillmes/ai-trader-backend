import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { BREADTH_V1_EVIDENCE_SCHEMA_VERSION, BREADTH_V1_UNIVERSE_DEFINITION_VERSION, computeDailyBreadthV1Observation } from '../services/breadth-v1-calculation.js';
import { DEFAULT_BREADTH_CACHE_DIR, readCached } from './breadth-research-cache.js';

/** Generates the frozen, checked-in BREADTH_V1 historical bootstrap artifact directly from
 * the already-accepted Breadth research disk cache (`node_modules/.cache/breadth/`). Makes
 * ZERO provider (Massive) calls: every input is a `readCached` disk read. Only the derived,
 * per-session facts a MarketBreadthObservation row needs are included — no raw per-ticker
 * evidence, no classifier/effective-state output. Deterministic: rerunning against the same
 * cache produces byte-identical rows and the same `canonicalArtifactHash`. */

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type BreadthV1BootstrapRow = {
  sessionDate: string; previousSessionDate: string;
  universeCount: number; currentBarCount: number; priorBarCount: number;
  advancingCount: number; decliningCount: number; unchangedCount: number; directionalCount: number; excludedCount: number;
  advanceShare: number; netBreadth: number;
  canonicalInputHash: string;
  provenance: { universeHash: string; currentGroupedHash: string; priorGroupedHash: string };
};
export type BreadthV1BootstrapArtifact = {
  artifactVersion: 1; provider: 'MASSIVE'; universeDefinitionVersion: string; evidenceSchemaVersion: number;
  from: string; through: string; rowCount: number; rows: BreadthV1BootstrapRow[]; canonicalArtifactHash: string;
};

function sortedRelevantEntries(universe: readonly string[], grouped: Readonly<Record<string, number>>): [string, number][] {
  return [...universe].filter(ticker => grouped[ticker] !== undefined).sort().map(ticker => [ticker, grouped[ticker]!]);
}
async function listCachedDates(cacheDir: string, kind: 'universe' | 'grouped'): Promise<string[]> {
  let entries: string[];
  try { entries = await readdir(path.join(cacheDir, kind)); }
  catch { return []; } // No cache directory at all: reported as "no cached evidence found", not a crash.
  return entries.filter(name => name.endsWith('.json')).map(name => name.replace(/\.json$/, '')).sort();
}

export async function generateBreadthV1BootstrapArtifact(cacheDir: string = DEFAULT_BREADTH_CACHE_DIR): Promise<BreadthV1BootstrapArtifact> {
  const sessions = await listCachedDates(cacheDir, 'universe');
  const groupedDates = await listCachedDates(cacheDir, 'grouped');
  if (!sessions.length) throw new Error('No cached Breadth universe evidence found. Run the accepted research pass (npm run research:breadth -- --fetch) first; this generator makes zero provider calls itself.');
  if (groupedDates.length !== sessions.length + 1) throw new Error(`Cache inconsistency: expected ${sessions.length + 1} grouped dates (one previous-session boundary plus each universe session), found ${groupedDates.length}. STOP.`);
  for (let i = 0; i < sessions.length; i++) {
    if (groupedDates[i + 1] !== sessions[i]) throw new Error(`Cache misalignment at index ${i}: grouped date ${groupedDates[i + 1]} does not align with universe session ${sessions[i]}. STOP.`);
  }

  const rows: BreadthV1BootstrapRow[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const sessionDate = sessions[i]!;
    const previousSessionDate = groupedDates[i]!;
    const [universeResult, currentResult, priorResult] = await Promise.all([
      readCached<string[]>(cacheDir, 'universe', sessionDate),
      readCached<Record<string, number>>(cacheDir, 'grouped', sessionDate),
      readCached<Record<string, number>>(cacheDir, 'grouped', previousSessionDate),
    ]);
    if (!universeResult || !currentResult || !priorResult) throw new Error(`Required cached evidence for ${sessionDate} is unexpectedly missing. STOP.`);
    if (!universeResult.ok || !currentResult.ok || !priorResult.ok) continue; // A resolved provider failure: no fabricated row.
    const universe = universeResult.value;
    const current = new Map(Object.entries(currentResult.value));
    const prior = new Map(Object.entries(priorResult.value));
    const observation = computeDailyBreadthV1Observation(universe, current, prior);
    if (observation.status !== 'VALID') continue; // Zero-directional session: no fabricated row.
    const universeHash = hash([...universe].sort());
    const currentGroupedHash = hash(sortedRelevantEntries(universe, currentResult.value));
    const priorGroupedHash = hash(sortedRelevantEntries(universe, priorResult.value));
    const canonicalInputHash = hash({
      sessionDate, previousSessionDate, universeHash, currentGroupedHash, priorGroupedHash,
      provider: 'MASSIVE', universeDefinitionVersion: BREADTH_V1_UNIVERSE_DEFINITION_VERSION, evidenceSchemaVersion: BREADTH_V1_EVIDENCE_SCHEMA_VERSION,
    });
    rows.push({
      sessionDate, previousSessionDate,
      universeCount: observation.universeCount, currentBarCount: observation.currentBarsFound, priorBarCount: observation.priorBarsFound,
      advancingCount: observation.advancingCount, decliningCount: observation.decliningCount, unchangedCount: observation.unchangedCount,
      directionalCount: observation.directionalCount, excludedCount: observation.excludedCount,
      advanceShare: observation.advanceShare!, netBreadth: observation.netBreadth!,
      canonicalInputHash, provenance: { universeHash, currentGroupedHash, priorGroupedHash },
    });
  }
  if (!rows.length) throw new Error('No valid observations could be derived from the cache. STOP.');
  const withoutHash = {
    artifactVersion: 1 as const, provider: 'MASSIVE' as const, universeDefinitionVersion: BREADTH_V1_UNIVERSE_DEFINITION_VERSION,
    evidenceSchemaVersion: BREADTH_V1_EVIDENCE_SCHEMA_VERSION, from: sessions[0]!, through: sessions.at(-1)!, rowCount: rows.length, rows,
  };
  return { ...withoutHash, canonicalArtifactHash: hash(withoutHash) };
}
