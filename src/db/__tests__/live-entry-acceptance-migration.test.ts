import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'prisma/migrations/20260820120000_add_live_entry_acceptance_runs/migration.sql';
const indexAlignmentMigrationPath =
  'prisma/migrations/20260820130000_align_live_entry_acceptance_index_name/migration.sql';

describe('Live-entry acceptance migration safety constraints', () => {
  it('keeps ACTION_REQUIRED derived and reserves terminal outcomes for resolved runs', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain("'CANARY_COMPLETE'");
    expect(sql).toContain("'FAILED_SAFE'");
    expect(sql).toContain("'OPERATOR_ABORTED'");
    expect(sql).not.toContain("'ACTION_REQUIRED'");
    expect(sql).toContain('"LiveEntryAcceptanceRun_terminal_pair_check"');
  });

  it('allows only one unresolved run per account and one arming and intent per run', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('"LiveEntryAcceptanceRun_active_account_key"');
    expect(sql).toContain('WHERE "terminalAt" IS NULL');
    expect(sql).toContain('"LiveEntryArming_liveEntryAcceptanceRunId_key"');
    expect(sql).toContain('"OrderIntent_liveEntryAcceptanceRunId_key"');
  });

  it('freezes preview material after execution is claimed', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('"LiveEntryAcceptanceRun_freeze_executed_preview"');
    expect(sql).toContain('OLD."executionClaimedAt" IS NOT NULL');
    expect(sql).toContain(
      "RAISE EXCEPTION 'Executed Live-entry acceptance preview is immutable'",
    );
  });

  it('aligns the PostgreSQL-truncated subscription index with the mapped schema name', async () => {
    const sql = await readFile(indexAlignmentMigrationPath, 'utf8');

    expect(sql).toContain(
      'ALTER INDEX "LiveEntryAcceptanceRun_tradingAccountSubscriptionId_createdAt_i"',
    );
    expect(sql).toContain(
      'RENAME TO "LiveEntryAcceptanceRun_tradingAccountSubscriptionId_created_idx"',
    );
  });

  it('has no other explicitly named migration objects above the PostgreSQL identifier limit', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const objectNames = Array.from(
      sql.matchAll(
        /(?:INDEX|CONSTRAINT|FUNCTION|TRIGGER|TYPE|TABLE)\s+"([^"]+)"/giu,
      ),
      (match) => match[1]!,
    );

    expect(objectNames.filter((name) => name.length > 63)).toEqual([
      'LiveEntryAcceptanceRun_tradingAccountSubscriptionId_createdAt_idx',
    ]);
  });
});
