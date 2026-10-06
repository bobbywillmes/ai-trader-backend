import { createHash } from 'node:crypto';
import { HORIZONS, compareRawCloses, finalizeBreadth, type ResearchBar } from './breadth-v2-measurement-calculation.js';
import { advanceFrozenBreadthV2, classifyFrozenBreadthV2Shares } from './breadth-v2.definition.js';
import type { BreadthState, MildDeteriorationHistory } from './breadth-calculation.js';

export const BREADTH_V2_BOOTSTRAP = Object.freeze({
  version: 'BREADTH_V2_BOOTSTRAP_V1', replayFrom: '2021-01-04',
  populationPolicy: 'TARGET_OBSERVATION_REVISION_FIXED_BACKCAST',
  provider: 'TIINGO', timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED',
  gapPolicy: 'STRICT', splitNormalizationVersion: 'RAW_CLOSE_CUMULATIVE_TIINGO_SPLIT_V1',
  classifier: 'BREADTH_V2_TERTILE_V1',
});

type Member = { securityId: number; symbol: string };
type Counts = { advancing: number; declining: number; unchanged: number };
const emptyCounts = (): Counts => ({ advancing: 0, declining: 0, unchanged: 0 });

/** Accumulates a fixed target-revision backcast one Security at a time; only per-session counts remain in memory. */
export class BreadthV2BootstrapAccumulator {
  private readonly counts = new Map<string, Counts>();
  private readonly inputHash = createHash('sha256');
  private memberCount = 0;
  private lastSymbol: string | null = null;
  private readonly targetIndexes: number[];

  constructor(private readonly sessions: readonly string[], private readonly replayFrom: string, private readonly replayThrough: string, private readonly revisionId: number, private readonly constituentHash: string) {
    if (!sessions.length || sessions.some((date, i) => i > 0 && date <= sessions[i - 1]!)) throw new Error('Unique chronological replay sessions required.');
    this.targetIndexes = sessions.flatMap((date, index) => date >= replayFrom && date <= replayThrough ? [index] : []);
    if (!this.targetIndexes.length) throw new Error('No reviewed bootstrap target sessions.');
    this.inputHash.update(JSON.stringify({ bootstrap: BREADTH_V2_BOOTSTRAP, sessions, replayThrough, revisionId, constituentHash }) + '\n');
    for (const index of this.targetIndexes) for (const horizon of HORIZONS) this.counts.set(`${index}:${horizon}`, emptyCounts());
  }

  addMember(member: Member, bars: ReadonlyMap<string, ResearchBar>, canonicalEvidence: readonly string[] = []) {
    if (this.lastSymbol !== null && member.symbol <= this.lastSymbol) throw new Error('Bootstrap members must be unique and sorted by canonical symbol.');
    this.lastSymbol = member.symbol; this.memberCount++;
    this.inputHash.update(`member:${member.symbol}:${member.securityId}\n`);
    for (const line of canonicalEvidence) this.inputHash.update(`bar:${line}\n`);
    for (const targetIndex of this.targetIndexes) for (const horizon of HORIZONS) {
      const anchorIndex = targetIndex - horizon;
      if (anchorIndex < 0) continue;
      const comparison = compareRawCloses(this.sessions, anchorIndex, targetIndex, bars);
      if (!comparison) continue;
      const counts = this.counts.get(`${targetIndex}:${horizon}`)!;
      if (comparison.direction === 'ADVANCING') counts.advancing++;
      else if (comparison.direction === 'DECLINING') counts.declining++;
      else counts.unchanged++;
    }
  }

  finish() {
    if (this.memberCount === 0) throw new Error('Bootstrap population is empty.');
    const state: MildDeteriorationHistory = { effectiveState: null, recoveryConfirmation: 0, mildDeteriorationConfirmation: 0 };
    const rawStates: (BreadthState | null)[] = [];
    let validRawSessionCount = 0;
    let firstValidSession: string | null = null;
    for (const index of this.targetIndexes) {
      const shares = Object.fromEntries(HORIZONS.map(horizon => {
        const counts = this.counts.get(`${index}:${horizon}`)!;
        return [`DAY_${horizon}`, finalizeBreadth(this.memberCount, counts.advancing, counts.declining, counts.unchanged).advanceShare];
      })) as { DAY_1: number | null; DAY_5: number | null; DAY_20: number | null };
      const raw = classifyFrozenBreadthV2Shares(shares).rawState;
      rawStates.push(raw);
      if (raw !== null) { validRawSessionCount++; firstValidSession ??= this.sessions[index]!; }
      const transition = advanceFrozenBreadthV2(state, raw);
      state.effectiveState = transition.effectiveState;
      state.recoveryConfirmation = transition.recoveryConfirmationAfter;
      state.mildDeteriorationConfirmation = transition.mildDeteriorationConfirmationAfter;
    }
    const canonicalInputHash = this.inputHash.digest('hex');
    const historicalReplayHash = createHash('sha256').update(JSON.stringify({ canonicalInputHash, rawStates })).digest('hex');
    return {
      bootstrapVersion: BREADTH_V2_BOOTSTRAP.version, replayFrom: this.replayFrom, replayThrough: this.replayThrough,
      populationPolicy: BREADTH_V2_BOOTSTRAP.populationPolicy, revisionId: this.revisionId, memberCount: this.memberCount,
      constituentHash: this.constituentHash, expectedSessionCount: this.targetIndexes.length,
      validRawSessionCount, unavailableRawSessionCount: this.targetIndexes.length - validRawSessionCount,
      firstValidSession, historicalReplayHash, canonicalInputHash,
      preCurrentEffectiveState: state.effectiveState, preCurrentRecoveryConfirmation: state.recoveryConfirmation,
      preCurrentMildDeteriorationConfirmation: state.mildDeteriorationConfirmation,
      rawStates,
    };
  }
}
