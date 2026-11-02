import { describe, expect, it } from 'vitest';
import { bodyDigestSql, compareWithManifest, evaluateTriggerOrder, TRIGGER_ORDER_INVARIANTS, type SecurityCatalog, type TriggerCatalogRow } from './database-security-readiness.service.js';
import type { ManifestTrigger } from './database-security-manifest.js';

const trigger = (overrides: Partial<ManifestTrigger> = {}): ManifestTrigger => ({
  function: 'f()', enabled: 'O', timing: 'BEFORE', events: 'INSERT', scope: 'ROW', when: '', columns: '', arguments: '',
  deferrable: false, initiallyDeferred: false, transitionTables: '/', ...overrides,
});

describe('compareWithManifest', () => {
  const manifest = { functions: {}, triggers: { 'A/a_guard': trigger(), 'B/b_audit': trigger({ events: 'UPDATE' }) } };

  it('reports a reviewed trigger that is absent from the database', () => {
    const catalog: SecurityCatalog = { functions: {}, triggers: { 'A/a_guard': trigger() } };
    expect(compareWithManifest(catalog, manifest)).toMatchObject({ triggersMissing: ['B/b_audit'], triggersChanged: [], triggersUnreviewed: [] });
  });

  it('is clean for an unchanged schema, and still reports modified and unreviewed triggers', () => {
    expect(compareWithManifest({ functions: {}, triggers: { ...manifest.triggers } }, manifest)).toMatchObject({ triggersMissing: [], triggersChanged: [], triggersUnreviewed: [] });
    const drifted = compareWithManifest({ functions: {}, triggers: { 'A/a_guard': trigger({ enabled: 'D' }), 'B/b_audit': trigger({ events: 'UPDATE' }), 'C/c_new': trigger() } }, manifest);
    expect(drifted.triggersChanged).toHaveLength(1); expect(drifted.triggersUnreviewed).toEqual(['C/c_new']);
  });
});

describe('bodyDigestSql', () => {
  it('converts only CRLF to LF, never a standalone carriage return', () => {
    const sql = bodyDigestSql('p.prosrc');
    expect(sql).toContain('chr(13) || chr(10), chr(10)');
    expect(sql).not.toMatch(/chr\(13\),\s*''/);
  });
});

describe('evaluateTriggerOrder (trigger firing order is name order)', () => {
  // tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16.
  const BEFORE_INSERT_ROW = 1 + 2 + 4;
  const AFTER_INSERT_ROW = 1 + 4;
  const row = (table: string, name: string, tgtype = BEFORE_INSERT_ROW): TriggerCatalogRow => ({ table_name: table, trigger_name: name, tgtype, enabled: 'O' });
  const shipped: TriggerCatalogRow[] = [
    row('EntryExposureClaimEvent', 'EntryExposureClaimEvent_external_signal_c2_delivery_fence'),
    row('EntryExposureClaimEvent', 'EntryExposureClaimEvent_external_signal_c2_not_sent_guard'),
    row('EntryExposureClaimEvent', 'EntryExposureClaimEvent_append_only', 1 + 2 + 8 + 16),
    row('MarketPolicyBrokerDispatchConsumption', 'BrokerDispatchConsumption_a_lock_prelude'),
    row('MarketPolicyBrokerDispatchConsumption', 'BrokerDispatchConsumption_validate'),
    row('OrderIntent', 'OrderIntent_a_epoch_stamp'),
    row('OrderIntent', 'OrderIntent_external_signal_dispatch_quarantine'),
    row('ExternalSignalTradeCycleAccount', 'ExternalSignalTradeCycleAccount_a_epoch_stamp'),
    row('ExternalSignalTradeCycleAccount', 'ExternalSignalTradeCycleAccount_paper_only'),
    row('ExternalSignalBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump', AFTER_INSERT_ROW),
    row('ExternalSignalBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption_zz_b_fence_verify', AFTER_INSERT_ROW),
  ];

  it('accepts the shipped order, whatever order the catalog returns the rows in', () => {
    expect(evaluateTriggerOrder(shipped)).toEqual([]);
    expect(evaluateTriggerOrder([...shipped].reverse())).toEqual([]);
  });

  it('pins every rule to a real, distinct table and trigger sequence', () => {
    expect(TRIGGER_ORDER_INVARIANTS.length).toBeGreaterThanOrEqual(5);
    for (const rule of TRIGGER_ORDER_INVARIANTS) expect(new Set(rule.sequence).size).toBe(rule.sequence.length);
  });

  it('reports a new trigger that sorts between the delivery fence and the not-sent guard', () => {
    const violations = evaluateTriggerOrder([...shipped, row('EntryExposureClaimEvent', 'EntryExposureClaimEvent_external_signal_c2_hijack')]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ table: 'EntryExposureClaimEvent', timing: 'BEFORE', event: 'INSERT' });
    expect(violations[0]!.problems.join(' ')).toContain('another trigger fires between them');
  });

  it('reports a trigger that fires before the lock prelude and before the epoch stamps', () => {
    expect(evaluateTriggerOrder([...shipped, row('MarketPolicyBrokerDispatchConsumption', 'BrokerDispatchConsumption_0_first')]).map(v => v.table)).toEqual(['MarketPolicyBrokerDispatchConsumption']);
    expect(evaluateTriggerOrder([...shipped, row('OrderIntent', 'OrderIntent_0_early')]).map(v => v.table)).toEqual(['OrderIntent']);
    expect(evaluateTriggerOrder([...shipped, row('ExternalSignalTradeCycleAccount', 'ExternalSignalTradeCycleAccount_0_early')]).map(v => v.table)).toEqual(['ExternalSignalTradeCycleAccount']);
  });

  it('reports a renamed or absent protected trigger, and a flipped bump/verify pair', () => {
    const renamed = shipped.map(r => r.trigger_name.endsWith('c2_delivery_fence') ? { ...r, trigger_name: 'EntryExposureClaimEvent_external_signal_c2_zz_delivery_fence' } : r);
    expect(evaluateTriggerOrder(renamed).map(v => v.table)).toContain('EntryExposureClaimEvent');
    expect(evaluateTriggerOrder(shipped.filter(r => !r.trigger_name.endsWith('a_lock_prelude'))).map(v => v.table)).toEqual(['MarketPolicyBrokerDispatchConsumption']);
    const flipped = shipped.map(r => r.trigger_name.endsWith('zz_a_fence_bump') ? { ...r, trigger_name: 'ExternalSignalBrokerDispatchConsumption_zz_c_fence_bump' } : r);
    expect(evaluateTriggerOrder(flipped).map(v => v.table)).toEqual(['ExternalSignalBrokerDispatchConsumption']);
  });

  it('ignores statement-level and other-event triggers when deciding order', () => {
    expect(evaluateTriggerOrder([...shipped, row('EntryExposureClaimEvent', 'EntryExposureClaimEvent_external_signal_c2_hijack', 2 + 4)])).toEqual([]);
    expect(evaluateTriggerOrder([...shipped, row('EntryExposureClaimEvent', 'EntryExposureClaimEvent_external_signal_c2_hijack', 1 + 16)])).toEqual([]);
  });
});
