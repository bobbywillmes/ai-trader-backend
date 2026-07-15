import { MomentumCandidateState } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  ACTIVE_MOMENTUM_CANDIDATE_STATES,
  TERMINAL_MOMENTUM_CANDIDATE_STATES,
  canPrepareMomentumHandoffState,
  canPriceConfirmMomentumCandidateState,
  isActiveMomentumCandidateState,
  isActiveUnexpiredMomentumCandidate,
  isMomentumCandidateExpired,
  isTerminalMomentumCandidateState,
} from './momentum-candidate-lifecycle.js';

describe('momentum candidate lifecycle', () => {
  it.each(ACTIVE_MOMENTUM_CANDIDATE_STATES)(
    'classifies %s as active and non-terminal',
    (state) => {
      expect(isActiveMomentumCandidateState(state)).toBe(true);
      expect(isTerminalMomentumCandidateState(state)).toBe(false);
      expect(canPriceConfirmMomentumCandidateState(state)).toBe(true);
    }
  );

  it.each(TERMINAL_MOMENTUM_CANDIDATE_STATES)(
    'classifies %s as terminal and inactive',
    (state) => {
      expect(isTerminalMomentumCandidateState(state)).toBe(true);
      expect(isActiveMomentumCandidateState(state)).toBe(false);
      expect(canPriceConfirmMomentumCandidateState(state)).toBe(false);
    }
  );

  it('allows only ENTRY_READY to prepare a handoff', () => {
    for (const state of Object.values(MomentumCandidateState)) {
      expect(canPrepareMomentumHandoffState(state)).toBe(
        state === MomentumCandidateState.ENTRY_READY
      );
    }
  });

  it('treats the exact expiration boundary as expired', () => {
    const now = new Date('2026-07-15T18:00:00.000Z');

    expect(isMomentumCandidateExpired(new Date(now.getTime() + 1), now)).toBe(false);
    expect(isMomentumCandidateExpired(now, now)).toBe(true);
    expect(isMomentumCandidateExpired(new Date(now.getTime() - 1), now)).toBe(true);
    expect(isMomentumCandidateExpired(null, now)).toBe(false);
  });

  it('requires both an active state and an unelapsed expiration', () => {
    const now = new Date('2026-07-15T18:00:00.000Z');

    expect(
      isActiveUnexpiredMomentumCandidate(
        { state: MomentumCandidateState.DISCOVERED, expiresAt: new Date(now.getTime() + 1) },
        now
      )
    ).toBe(true);
    expect(
      isActiveUnexpiredMomentumCandidate(
        { state: MomentumCandidateState.DISCOVERED, expiresAt: now },
        now
      )
    ).toBe(false);
    expect(
      isActiveUnexpiredMomentumCandidate(
        { state: MomentumCandidateState.EXPIRED, expiresAt: null },
        now
      )
    ).toBe(false);
  });
});
