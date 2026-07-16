import { MomentumCandidateState } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { decideMomentumConfirmation } from './momentum-confirmation-decision.js';

const base = {
  catalystScore: 85,
  priceActionScore: 75,
  volumeScore: 80,
  setupQualityScore: 100,
  hardBlocks: [],
  dataComplete: true,
  currentState: MomentumCandidateState.DISCOVERED,
  expired: false,
  entryReadyThreshold: 80,
};

describe('momentum confirmation decision', () => {
  it('calculates the documented weighted candidate total', () => {
    expect(decideMomentumConfirmation(base)).toMatchObject({
      candidateTotalScore: 82,
      totalConfirmationScore: 82,
      decision: 'ENTRY_READY',
      state: MomentumCandidateState.ENTRY_READY,
      confirmed: true,
    });
  });

  it.each([
    ['incomplete data', { dataComplete: false }, 'WATCHING', MomentumCandidateState.WATCHING],
    ['a hard block', { hardBlocks: ['BELOW_VWAP'] }, 'ENTRY_BLOCKED', MomentumCandidateState.ENTRY_BLOCKED],
    ['an expired lifecycle', { expired: true }, 'EXPIRED', MomentumCandidateState.EXPIRED],
    ['an existing expired state', { currentState: MomentumCandidateState.EXPIRED }, 'EXPIRED', MomentumCandidateState.EXPIRED],
    ['an existing dismissed state', { currentState: MomentumCandidateState.DISMISSED }, 'DISMISSED', MomentumCandidateState.DISMISSED],
  ])('handles %s deterministically', (_label, overrides, decision, state) => {
    expect(decideMomentumConfirmation({ ...base, ...overrides })).toMatchObject({
      decision,
      state,
      confirmed: false,
    });
  });

  it('moves a completed sub-threshold evaluation to watching', () => {
    expect(decideMomentumConfirmation({ ...base, catalystScore: 20 })).toMatchObject({
      decision: 'WATCHING',
      state: MomentumCandidateState.WATCHING,
      confirmed: false,
    });
  });

  it('deduplicates hard blocks and clamps component inputs', () => {
    expect(decideMomentumConfirmation({
      ...base,
      catalystScore: 200,
      priceActionScore: -10,
      hardBlocks: ['BELOW_VWAP', 'BELOW_VWAP'],
    })).toMatchObject({
      candidateTotalScore: 66,
      hardBlocks: ['BELOW_VWAP'],
    });
  });
});
