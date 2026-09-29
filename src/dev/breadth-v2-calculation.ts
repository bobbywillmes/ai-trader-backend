import { Prisma } from '@prisma/client';

export const BREADTH_V2_RESEARCH_VERSION = 'BREADTH_V2_RESEARCH_5A_V2';
export const SPLIT_NORMALIZATION_VERSION = 'RAW_CLOSE_CUMULATIVE_TIINGO_SPLIT_V1';
export const HORIZONS = [1, 5, 20] as const;
export type Horizon = typeof HORIZONS[number];
export type ResearchBar = { close: string; splitFactor: string };
export type Direction = 'ADVANCING' | 'DECLINING' | 'UNCHANGED';
export type Comparison = { direction: Direction; missingSplitEvidenceSessions: number };
const Decimal = Prisma.Decimal.clone({ precision: 80 });

/** Compare two real raw closes. A missing intervening session means its split factor is unknown. */
export function compareRawCloses(sessions: readonly string[], anchorIndex: number, targetIndex: number, bars: ReadonlyMap<string, ResearchBar>, allowMissingSplitEvidence = false): Comparison | null {
  const anchor = bars.get(sessions[anchorIndex]!);
  const target = bars.get(sessions[targetIndex]!);
  if (!anchor || !target || anchorIndex >= targetIndex) return null;
  let factor = new Decimal(1);
  let missingSplitEvidenceSessions = 0;
  for (let i = anchorIndex + 1; i <= targetIndex; i++) {
    const bar = bars.get(sessions[i]!);
    if (!bar) { missingSplitEvidenceSessions++; continue; }
    const split = new Decimal(bar.splitFactor);
    if (!split.isFinite() || split.lte(0)) return null;
    factor = factor.mul(split);
  }
  if (missingSplitEvidenceSessions && !allowMissingSplitEvidence) return null;
  const anchorClose = new Decimal(anchor.close);
  const targetClose = new Decimal(target.close);
  if (!anchorClose.isFinite() || !targetClose.isFinite() || anchorClose.lte(0) || targetClose.lte(0)) return null;
  const comparison = targetClose.mul(factor).cmp(anchorClose);
  return { direction: comparison > 0 ? 'ADVANCING' : comparison < 0 ? 'DECLINING' : 'UNCHANGED', missingSplitEvidenceSessions };
}

export function bridgeCandidate(sessions: readonly string[], expectedAnchorIndex: number, targetIndex: number, bars: ReadonlyMap<string, ResearchBar>, maxGap: 1 | 2) {
  if (expectedAnchorIndex < 0 || !bars.has(sessions[targetIndex]!)) return null;
  for (let anchorIndex = expectedAnchorIndex; anchorIndex >= Math.max(0, expectedAnchorIndex - maxGap); anchorIndex--) {
    if (!bars.has(sessions[anchorIndex]!)) continue;
    const comparison = compareRawCloses(sessions, anchorIndex, targetIndex, bars, true);
    if (comparison && comparison.missingSplitEvidenceSessions > 0 && comparison.missingSplitEvidenceSessions <= maxGap) {
      return { expectedAnchorSession: sessions[expectedAnchorIndex]!, actualAnchorSession: sessions[anchorIndex]!, targetSession: sessions[targetIndex]!, bridgedGapSessions: comparison.missingSplitEvidenceSessions, direction: comparison.direction, splitEvidenceComplete: false };
    }
  }
  return null;
}

export type BreadthCounts = { universeCount: number; eligibleCount: number; excludedCount: number; advancingCount: number; decliningCount: number; unchangedCount: number; directionalCount: number; advanceShare: number | null; netBreadth: number | null; coverageRatio: number | null };
export function finalizeBreadth(universeCount: number, advancingCount: number, decliningCount: number, unchangedCount: number): BreadthCounts {
  const eligibleCount = advancingCount + decliningCount + unchangedCount;
  const directionalCount = advancingCount + decliningCount;
  return { universeCount, eligibleCount, excludedCount: universeCount - eligibleCount, advancingCount, decliningCount, unchangedCount, directionalCount,
    advanceShare: directionalCount ? advancingCount / directionalCount : null,
    netBreadth: directionalCount ? (advancingCount - decliningCount) / directionalCount : null,
    coverageRatio: universeCount ? eligibleCount / universeCount : null };
}

export const GAP_SHAPES = ['FULL_RANGE_MISSING', 'LEADING_MISSING', 'INTERIOR_GAP', 'TRAILING_MISSING'] as const;
export type GapShape = typeof GAP_SHAPES[number];
export type MissingRun = { from: string; through: string; length: number; shape: GapShape; lengthBucket: 'ONE' | 'TWO' | 'THREE_TO_FIVE' | 'OVER_FIVE' };

export function missingRuns(sessions: readonly string[], bars: ReadonlyMap<string, ResearchBar>): MissingRun[] {
  const runs: MissingRun[] = [];
  const firstReal = sessions.findIndex(session => bars.has(session));
  let lastReal = -1;
  for (let i = sessions.length - 1; i >= 0; i--) if (bars.has(sessions[i]!)) { lastReal = i; break; }
  let start = -1;
  for (let i = 0; i <= sessions.length; i++) {
    if (i < sessions.length && !bars.has(sessions[i]!)) { if (start < 0) start = i; continue; }
    if (start >= 0) {
      const length = i - start;
      const shape: GapShape = firstReal < 0 ? 'FULL_RANGE_MISSING' : i <= firstReal ? 'LEADING_MISSING' : start > lastReal ? 'TRAILING_MISSING' : 'INTERIOR_GAP';
      runs.push({ from: sessions[start]!, through: sessions[i - 1]!, length, shape, lengthBucket: length === 1 ? 'ONE' : length === 2 ? 'TWO' : length <= 5 ? 'THREE_TO_FIVE' : 'OVER_FIVE' });
      start = -1;
    }
  }
  return runs;
}

type GapShapeCounts = { runCount: number; missingSessions: number; affectedSecurities: number; longestRun: number };
type InteriorGapExample = { symbol: string; fromSession: string; throughSession: string; lengthSessions: number };
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export class GapShapeAccumulator {
  private readonly counts = Object.fromEntries(GAP_SHAPES.map(shape => [shape, { runCount: 0, missingSessions: 0, longestRun: 0 }])) as Record<GapShape, Omit<GapShapeCounts, 'affectedSecurities'>>;
  private readonly securities = Object.fromEntries(GAP_SHAPES.map(shape => [shape, new Set<string>()])) as Record<GapShape, Set<string>>;
  private readonly interiorExamples: InteriorGapExample[] = [];

  add(symbol: string, run: MissingRun) {
    const counts = this.counts[run.shape];
    counts.runCount++;
    counts.missingSessions += run.length;
    counts.longestRun = Math.max(counts.longestRun, run.length);
    this.securities[run.shape].add(symbol);
    if (run.shape === 'INTERIOR_GAP') {
      this.interiorExamples.push({ symbol, fromSession: run.from, throughSession: run.through, lengthSessions: run.length });
      this.interiorExamples.sort((a, b) => b.lengthSessions - a.lengthSessions || compareText(a.symbol, b.symbol) || compareText(a.fromSession, b.fromSession));
      this.interiorExamples.length = Math.min(this.interiorExamples.length, 25);
    }
  }

  summary() {
    const gapShapes = Object.fromEntries(GAP_SHAPES.map(shape => [shape, { ...this.counts[shape], affectedSecurities: this.securities[shape].size }])) as Record<GapShape, GapShapeCounts>;
    const interiorMissingSessions = gapShapes.INTERIOR_GAP.missingSessions;
    const nonInteriorMissingSessions = gapShapes.FULL_RANGE_MISSING.missingSessions + gapShapes.LEADING_MISSING.missingSessions + gapShapes.TRAILING_MISSING.missingSessions;
    return { gapShapes, interiorMissingSessions, nonInteriorMissingSessions, longestInteriorGaps: [...this.interiorExamples] };
  }
}
