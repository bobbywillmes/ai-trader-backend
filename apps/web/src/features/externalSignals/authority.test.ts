import { describe, expect, it } from 'vitest';
import { parseDispatchStatus, parseEntryExecutionAuthorizations, parseExecutionRolloutStatus } from './authority';

const execution = { activeExecutionGenerationId: 3, executionEpochAt: '2026-11-01T00:00:00Z', rolloutStateVersion: 5, generations: [{ id: 3, generation: 2, direction: 'ENTRY', enabled: true, authorityMode: 'EXECUTE', effectiveAt: '2026-10-01T00:00:00Z' }], activationEvents: [{ id: 8, rolloutGenerationId: 3, action: 'ACTIVATE', reason: 'reviewed', createdAt: '2026-11-01T00:00:00Z' }] };
const dispatch = { state: { version: 6, activeRolloutGenerationId: 3, activatedAt: '2026-11-02T00:00:00Z' }, activationEvents: [{ id: 9, rolloutGenerationId: 3, action: 'ACTIVATE', stateVersion: 6, reason: 'reviewed', createdAt: '2026-11-02T00:00:00Z' }] };
const authorization = { id: 12, rolloutGenerationId: 3, authorizationSequence: 1, status: 'AUTHORIZED', tradingAccountId: 120, tradingAccountSubscriptionId: 220, subscriptionId: 320, securityId: 5, signalSourceId: 1, strategySignalBindingId: 2, strategySignalRevisionId: 7, strategyRevision: 1, authorizedAt: '2026-11-01T00:00:00Z', revokedAt: null, invalidatedAt: null, invalidationReasonCode: null };

describe('authority response parsers', () => {
  it('accepts valid populated, empty, inactive, and revoked responses', () => {
    expect(parseExecutionRolloutStatus(execution).status).toBe('ok');
    expect(parseExecutionRolloutStatus({ ...execution, activeExecutionGenerationId: null, executionEpochAt: null, generations: [], activationEvents: [] }).status).toBe('ok');
    expect(parseDispatchStatus(dispatch).status).toBe('ok');
    expect(parseDispatchStatus({ state: { version: 1, activeRolloutGenerationId: null, activatedAt: null }, activationEvents: [] }).status).toBe('ok');
    expect(parseEntryExecutionAuthorizations({ authorizations: [] }, 120, 220).status).toBe('ok');
    expect(parseEntryExecutionAuthorizations({ authorizations: [{ ...authorization, status: 'REVOKED', revokedAt: '2026-11-03T00:00:00Z' }] }, 120, 220).status).toBe('ok');
  });

  it.each([{}, null, { ...execution, generations: null }, { ...execution, activationEvents: 'bad' }, { ...execution, activeExecutionGenerationId: {} }, { ...execution, executionEpochAt: 'not-a-date' }])('rejects malformed execution rollout %#', value => {
    expect(parseExecutionRolloutStatus(value).status).toBe('invalid');
  });

  it.each([{}, null, { ...dispatch, state: null }, { ...dispatch, activationEvents: 'bad' }, { ...dispatch, state: { ...dispatch.state, activeRolloutGenerationId: {} } }, { ...dispatch, state: { ...dispatch.state, activatedAt: 'not-a-date' } }])('rejects malformed dispatch status %#', value => {
    expect(parseDispatchStatus(value).status).toBe('invalid');
  });

  it.each([[authorization], null, 'bad', {}, { authorizations: null }, { authorizations: [{ ...authorization, id: {} }] }, { authorizations: [{ ...authorization, status: {} }] }, { authorizations: [{ ...authorization, authorizedAt: 'not-a-date' }] }])('rejects malformed authorization history %#', value => {
    expect(parseEntryExecutionAuthorizations(value, 120, 220).status).toBe('invalid');
  });

  it('rejects records outside the requested account and assignment scope', () => {
    expect(parseEntryExecutionAuthorizations({ authorizations: [{ ...authorization, tradingAccountId: 121 }] }, 120, 220).status).toBe('invalid');
    expect(parseEntryExecutionAuthorizations({ authorizations: [{ ...authorization, tradingAccountSubscriptionId: 221 }] }, 120, 220).status).toBe('invalid');
  });
});
