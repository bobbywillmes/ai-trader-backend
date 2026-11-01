import { describe, expect, it } from 'vitest';
import { bodyDigestSql, compareWithManifest, type SecurityCatalog } from './database-security-readiness.service.js';
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
