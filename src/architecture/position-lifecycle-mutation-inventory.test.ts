import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { POSITION_LIFECYCLE_MUTATION_INVENTORY } from './position-lifecycle-mutation-inventory.js';

const ROOT = resolve(process.cwd());
const SCAN_ROOTS = ['src', 'scripts'] as const;
const DIRECT_MUTATION = /\b(?:trackedPosition|positionExitState)\.(?:createMany|create|updateMany|update|upsert|deleteMany|delete)\b/g;
const RAW_SQL_MUTATION = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(?:TrackedPosition|PositionExitState)"/gi;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) return [];
    return [path];
  });
}

function observedInventory() {
  const observed = new Map<string, Record<string, number>>();
  const rawSql: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const absolute of sourceFiles(resolve(ROOT, root))) {
      const file = relative(ROOT, absolute).replaceAll('\\', '/');
      if (file === 'src/architecture/position-lifecycle-mutation-inventory.ts') continue;
      const source = readFileSync(absolute, 'utf8');
      const operations: Record<string, number> = {};
      for (const match of source.matchAll(DIRECT_MUTATION)) {
        operations[match[0]] = (operations[match[0]] ?? 0) + 1;
      }
      if (Object.keys(operations).length > 0) observed.set(file, operations);
      if (RAW_SQL_MUTATION.test(source)) rawSql.push(file);
      RAW_SQL_MUTATION.lastIndex = 0;
    }
  }
  return { observed, rawSql };
}

describe('position lifecycle mutation architecture inventory', () => {
  it('requires every direct writer and operation count to be reviewed in the manifest', () => {
    const { observed } = observedInventory();
    const expected = new Map(POSITION_LIFECYCLE_MUTATION_INVENTORY.map((entry) => [entry.file, entry.operations]));
    expect(Object.fromEntries(observed)).toEqual(Object.fromEntries(expected));
  });

  it('rejects unreviewed raw SQL mutations of protected lifecycle models', () => {
    expect(observedInventory().rawSql).toEqual([]);
  });

  it('records future boundary requirements without claiming Phase 0 compliance', () => {
    const runtimeEntries = POSITION_LIFECYCLE_MUTATION_INVENTORY.filter((entry) => entry.futureBoundary === 'REQUIRED');
    expect(runtimeEntries.length).toBeGreaterThan(0);
    expect(runtimeEntries.some((entry) => entry.phase0Status === 'CURRENTLY_UNGUARDED')).toBe(true);
  });
});
