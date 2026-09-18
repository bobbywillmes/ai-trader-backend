import { describe, expect, it } from 'vitest';
import { canonicalSignalPayload, hashCanonicalPayload } from './external-signal-normalization.js';

describe('canonical Signal payload comparison', () => {
  const event = { schemaVersion: 1, strategyRevision: 2, event: 'ENTRY_LONG', symbol: 'QQQ', timeframe: '15m',
    signalTime: '2026-09-10T09:30:00Z', barTime: '2026-09-10T09:15:00Z', metadata: { test: 'same', nested: { rsi: 28.4 } } };
  it('hashes input and database representations identically and excludes every storage field', () => {
    const stored = { ...event, signalTime: new Date(event.signalTime), barTime: new Date(event.barTime),
      id: 999, signalSourceId: 1, strategySignalBindingId: 2, strategySignalRevisionId: 3, strategyId: 4, securityId: 5,
      eventFingerprint: 'stored-fingerprint', canonicalPayloadHash: 'old-hash', externalEventKey: null, createdAt: new Date() };
    const incoming = canonicalSignalPayload(event, 'momentum-stock');
    expect(canonicalSignalPayload(stored, 'momentum-stock')).toEqual(incoming);
    expect(hashCanonicalPayload(canonicalSignalPayload(stored, 'momentum-stock'))).toBe(hashCanonicalPayload(incoming));
    expect(Object.keys(incoming).sort()).toEqual(['schemaVersion', 'externalStrategyKey', 'strategyRevision', 'event', 'symbol', 'timeframe', 'signalTime', 'barTime', 'metadata'].sort());
  });
  it.each(['metadata', 'signalTime', 'schemaVersion'] as const)('preserves conflict detection for changed %s', field => {
    const changed = { ...event, [field]: field === 'metadata' ? { test: 'same.' } : field === 'schemaVersion' ? 2 : '2026-09-10T09:31:00Z' };
    expect(hashCanonicalPayload(canonicalSignalPayload(changed, 'momentum-stock'))).not.toBe(hashCanonicalPayload(canonicalSignalPayload(event, 'momentum-stock')));
  });
});
