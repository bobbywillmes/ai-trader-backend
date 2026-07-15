import { MomentumCandidateState } from '@prisma/client';

export const ACTIVE_MOMENTUM_CANDIDATE_STATES = [
  MomentumCandidateState.DISCOVERED,
  MomentumCandidateState.WATCHING,
  MomentumCandidateState.ENTRY_READY,
  MomentumCandidateState.ENTRY_BLOCKED,
] as const;

export const TERMINAL_MOMENTUM_CANDIDATE_STATES = [
  MomentumCandidateState.EXPIRED,
  MomentumCandidateState.DISMISSED,
] as const;

const activeStates = new Set<MomentumCandidateState>(
  ACTIVE_MOMENTUM_CANDIDATE_STATES
);
const terminalStates = new Set<MomentumCandidateState>(
  TERMINAL_MOMENTUM_CANDIDATE_STATES
);

export function isActiveMomentumCandidateState(state: MomentumCandidateState) {
  return activeStates.has(state);
}

export function isTerminalMomentumCandidateState(state: MomentumCandidateState) {
  return terminalStates.has(state);
}

export function isMomentumCandidateExpired(
  expiresAt: Date | null,
  now = new Date()
) {
  return expiresAt !== null && expiresAt <= now;
}

export function isActiveUnexpiredMomentumCandidate(
  candidate: Pick<{ state: MomentumCandidateState; expiresAt: Date | null }, 'state' | 'expiresAt'>,
  now = new Date()
) {
  return (
    isActiveMomentumCandidateState(candidate.state) &&
    !isMomentumCandidateExpired(candidate.expiresAt, now)
  );
}

export function canPriceConfirmMomentumCandidateState(
  state: MomentumCandidateState
) {
  return isActiveMomentumCandidateState(state);
}

export function canPrepareMomentumHandoffState(state: MomentumCandidateState) {
  return state === MomentumCandidateState.ENTRY_READY;
}
