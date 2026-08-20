import { describe, expect, it } from 'vitest';

import { deriveLiveEntryAcceptancePhase } from './live-entry-acceptance.service.js';

const base = {
  terminalOutcome: null,
  terminalAt: null,
  executionClaimedAt: null,
  executionUncertainAt: null,
  previewRevision: 0,
  previewFingerprint: null,
  liveEntryArming: null,
  orderIntent: null,
  setupReady: false,
  authorizationReady: false,
  readinessReady: false,
} as const;

describe('Live-entry acceptance phase derivation', () => {
  it.each([
    [{}, 'SETUP'],
    [{ setupReady: true }, 'AUTHORIZATION'],
    [{ setupReady: true, authorizationReady: true }, 'READINESS'],
    [{ setupReady: true, authorizationReady: true, readinessReady: true }, 'ARMING'],
    [{ liveEntryArming: { id: 4, entryApprovalExpiresAt: new Date(), terminations: [] } }, 'EXECUTION'],
    [{ executionClaimedAt: new Date() }, 'VERIFICATION'],
    [{ terminalAt: new Date(), terminalOutcome: 'CANARY_COMPLETE' }, 'COMPLETION'],
  ] as const)('derives authoritative phase from %j', (overrides, expected) => {
    expect(deriveLiveEntryAcceptancePhase({ ...base, ...overrides })).toBe(expected);
  });

  it('keeps uncertainty nonterminal and ahead of ordinary verification', () => {
    expect(deriveLiveEntryAcceptancePhase({
      ...base,
      executionClaimedAt: new Date(),
      executionUncertainAt: new Date(),
    })).toBe('ACTION_REQUIRED');
  });
});
