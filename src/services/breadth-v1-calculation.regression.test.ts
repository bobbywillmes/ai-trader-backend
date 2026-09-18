import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { calculateBreadthV1Series, type DailyBreadthV1Observation } from './breadth-v1-calculation.js';
import type { BreadthV1BootstrapArtifact } from '../dev/breadth-v1-bootstrap-artifact-generator.js';

/** Proves the frozen production BREADTH_V1 implementation did not subtly diverge from the
 * accepted research replay (STRUCTURAL_V3 raw classifier + STRUCTURAL_V3_MILD_DETERIORATION_
 * CONFIRMATION hysteresis). These expected values were read once from the accepted research
 * comparison output and are now frozen here as a fixture — this test never re-runs research
 * code or touches the research disk cache; it only replays the checked-in bootstrap artifact
 * through the independent production calculator. */

async function loadArtifact(): Promise<BreadthV1BootstrapArtifact> {
  const raw = await readFile('prisma/bootstrap/breadth-v1-bootstrap-artifact.json', 'utf8');
  return JSON.parse(raw) as BreadthV1BootstrapArtifact;
}

describe('BREADTH_V1 production replay matches the accepted research terminal result', () => {
  it('reproduces the exact accepted raw/effective state and both confirmation counters', async () => {
    const artifact = await loadArtifact();
    expect(artifact.rowCount).toBe(1252);
    expect(artifact.from).toBe('2021-09-16');
    expect(artifact.through).toBe('2026-09-16');

    const dates = artifact.rows.map(row => row.sessionDate);
    const observations: DailyBreadthV1Observation[] = artifact.rows.map(row => ({
      status: 'VALID', universeCount: row.universeCount, currentBarsFound: row.currentBarCount, priorBarsFound: row.priorBarCount,
      eligibleCount: row.advancingCount + row.decliningCount + row.unchangedCount, excludedCount: row.excludedCount,
      advancingCount: row.advancingCount, decliningCount: row.decliningCount, unchangedCount: row.unchangedCount,
      directionalCount: row.directionalCount, advanceShare: row.advanceShare, netBreadth: row.netBreadth,
    }));
    const series = calculateBreadthV1Series(dates, observations);

    const byDate = new Map(series.map(day => [day.date, day]));
    // Accepted research terminal result, 2026-09-16 (the last date in the accepted 5-year dataset).
    const terminal = byDate.get('2026-09-16')!;
    expect(terminal.rawState).toBe('NEGATIVE');
    expect(terminal.effectiveState).toBe('NEGATIVE');
    expect(terminal.hysteresis.recoveryConfirmationAfter).toBe(0);
    expect(terminal.hysteresis.mildDeteriorationConfirmationAfter).toBe(0);

    // A second, mid-history checkpoint with a nonzero recovery counter, so this regression
    // cannot pass merely because every counter happens to be zero at the very last date.
    const checkpoint = byDate.get('2026-09-02')!;
    expect(checkpoint.rawState).toBe('MIXED');
    expect(checkpoint.effectiveState).toBe('NEGATIVE');
    expect(checkpoint.hysteresis.recoveryConfirmationAfter).toBe(1);
    expect(checkpoint.hysteresis.mildDeteriorationConfirmationAfter).toBe(0);
  });
});
