import { MomentumCandidateState } from '@prisma/client';

export type MomentumConfirmationDecision =
  | 'WATCHING'
  | 'ENTRY_READY'
  | 'ENTRY_BLOCKED'
  | 'EXPIRED'
  | 'DISMISSED';

export type MomentumConfirmationDecisionInput = {
  catalystScore: number;
  priceActionScore: number;
  volumeScore: number;
  setupQualityScore: number;
  hardBlocks: string[];
  dataComplete: boolean;
  currentState: MomentumCandidateState;
  expired: boolean;
  entryReadyThreshold: number;
};

export type MomentumConfirmationDecisionResult = {
  totalConfirmationScore: number;
  candidateTotalScore: number;
  decision: MomentumConfirmationDecision;
  state: MomentumCandidateState;
  confirmed: boolean;
  reasons: string[];
  hardBlocks: string[];
};

function clampScore(value: number) {
  return Math.min(100, Math.max(0, value));
}

export function decideMomentumConfirmation(
  input: MomentumConfirmationDecisionInput
): MomentumConfirmationDecisionResult {
  const hardBlocks = [...new Set(input.hardBlocks)];
  const candidateTotalScore = Math.round(
    clampScore(input.catalystScore) * 0.45 +
      clampScore(input.priceActionScore) * 0.3 +
      clampScore(input.volumeScore) * 0.2 +
      clampScore(input.setupQualityScore) * 0.05
  );

  if (input.currentState === MomentumCandidateState.DISMISSED) {
    return terminalResult(candidateTotalScore, 'DISMISSED', MomentumCandidateState.DISMISSED, hardBlocks);
  }

  if (input.expired || input.currentState === MomentumCandidateState.EXPIRED) {
    return terminalResult(candidateTotalScore, 'EXPIRED', MomentumCandidateState.EXPIRED, hardBlocks);
  }

  if (hardBlocks.length > 0) {
    return {
      totalConfirmationScore: candidateTotalScore,
      candidateTotalScore,
      decision: 'ENTRY_BLOCKED',
      state: MomentumCandidateState.ENTRY_BLOCKED,
      confirmed: false,
      reasons: ['HARD_BLOCK_PRESENT'],
      hardBlocks,
    };
  }

  if (input.dataComplete && candidateTotalScore >= input.entryReadyThreshold) {
    return {
      totalConfirmationScore: candidateTotalScore,
      candidateTotalScore,
      decision: 'ENTRY_READY',
      state: MomentumCandidateState.ENTRY_READY,
      confirmed: true,
      reasons: ['ENTRY_READY_THRESHOLD_MET'],
      hardBlocks,
    };
  }

  return {
    totalConfirmationScore: candidateTotalScore,
    candidateTotalScore,
    decision: 'WATCHING',
    state: MomentumCandidateState.WATCHING,
    confirmed: false,
    reasons: [input.dataComplete ? 'ENTRY_READY_THRESHOLD_NOT_MET' : 'INCOMPLETE_CONFIRMATION_DATA'],
    hardBlocks,
  };
}

function terminalResult(
  score: number,
  decision: 'EXPIRED' | 'DISMISSED',
  state: MomentumCandidateState,
  hardBlocks: string[]
): MomentumConfirmationDecisionResult {
  return {
    totalConfirmationScore: score,
    candidateTotalScore: score,
    decision,
    state,
    confirmed: false,
    reasons: ['TERMINAL_CANDIDATE_STATE'],
    hardBlocks,
  };
}
