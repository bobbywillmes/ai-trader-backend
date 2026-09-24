import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { acquireCaptureLock, Journal, manifest, readJournal } from './journal.js';
import { normalize } from './model.js';
import { sessionPlan } from './session.js';

describe('journal evidence and dependency boundaries', () => {
  it('exclusively creates runs, fsyncs append-only records, and preserves crash tails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iex-journal-'));
    try {
      const run = join(root, 'run');
      const identity = manifest('test', '2026-09-22T13:00:00Z', sessionPlan('2026-09-22'), 'a'.repeat(40));
      const journal = await Journal.create(run, identity);
      const parsed = normalize({ T: 'b', S: 'SPY', t: '2026-09-22T13:30:00Z', o: 1, h: 2, l: 1, c: 2, v: 10 },
        { runId: 'test', connectionEpoch: 1, ordinal: 1, frameOrdinal: 1, elementIndex: 0, receivedAt: '2026-09-22T13:31:01Z', monotonicOffsetMs: 1 });
      if ('error' in parsed) throw new Error('fixture');
      await Promise.all([journal.observation(parsed.observation), journal.observation({ ...parsed.observation, ordinal: 2 })]);
      await journal.event({ type: 'shutdown_complete', at: '2026-09-22T13:32:00Z', connectionEpoch: 1 }); await journal.close();
      expect((await readJournal(join(run, 'observations-000001.ndjson'))).records).toHaveLength(2);
      const report = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'scripts/analyze-alpaca-iex-intraday.ts', run], {
        encoding: 'utf8', env: { ...process.env, ALPACA_MARKET_DATA_API_KEY: '', ALPACA_MARKET_DATA_API_SECRET: '', ALPACA_MARKET_DATA_FEED: '' }, timeout: 15_000,
      }));
      expect(report.authority).toBe('RESEARCH_ONLY'); expect(report.counts.observations).toBe(2);
      expect(report.cleanShutdown).toBe(true); expect(report.minuteCompleteness.SPY.observed).toBe(1);
      await expect(Journal.create(run, identity)).rejects.toThrow();
      const crash = join(root, 'crash.ndjson'); await writeFile(crash, '{"ok":true}\n{"incomplete":');
      expect(await readJournal(crash)).toEqual({ records: [{ ok: true }], truncatedFinalLine: true });
      expect(await readFile(crash, 'utf8')).toContain('incomplete');
      await writeFile(crash, 'broken\n{"ok":true}\n'); await expect(readJournal(crash)).rejects.toThrow('Corrupt');
      const release = await acquireCaptureLock(root); await expect(acquireCaptureLock(root)).rejects.toThrow(); await release();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('bounds the writer queue and surfaces a terminal persistence failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iex-pressure-'));
    try {
      const journal = await Journal.create(join(root, 'run'), manifest('test', '2026-09-22T13:00:00Z', sessionPlan('2026-09-22'), 'a'.repeat(40)));
      await expect(journal.event({ type: 'process_started', at: 'x'.repeat(8 * 1024 * 1024), connectionEpoch: 0 })).rejects.toThrow('capacity');
      await expect(journal.close()).rejects.toThrow('cleanly');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('transitively allows only research modules, explicit pure calendar modules and Node builtins', async () => {
    const root = resolve('.');
    const research = resolve('src/dev/alpaca-iex');
    const providers = resolve('src/dev/intraday-providers');
    const pure = new Set(['src/services/market-calendar.ts', 'src/services/market-calendar-bootstrap.definition.ts',
      'src/dev/intraday-stress-calendar.ts', 'src/dev/volatility-research-calendar.ts',
      'src/services/intraday-stress-calculation.ts', 'src/services/volatility-calculation.ts', 'src/services/trend-calculation.ts']);
    const allowedNode = new Set(['node:crypto', 'node:fs/promises', 'node:path', 'node:os', 'node:child_process', 'node:util']);
    const files = (await readdir(research)).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts')).map(n => join(research, n));
    files.push(...(await readdir(providers)).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts')).map(n => join(providers, n)));
    files.push(resolve('scripts/capture-alpaca-iex-intraday.ts'), resolve('scripts/analyze-alpaca-iex-intraday.ts'));
    files.push(resolve('scripts/compare-alpaca-iex-intraday.ts'));
    files.push(...['capture-intraday-providers', 'capture-intraday-provider', 'compare-intraday-providers', 'baseline-intraday-providers', 'tiingo-revision-forensics'].map(n => resolve(`scripts/${n}.ts`)));
    const seen = new Set<string>();
    const visit = async (file: string): Promise<void> => {
      if (seen.has(file)) return; seen.add(file);
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/Prisma|MarketBar|MarketRegimeDimensionAssessment|SignalEvaluation|EntryDecision|TradingAccount|\bfetch\s*\(/);
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const specifiers: string[] = [];
      const scan = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          expect(ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
          specifiers.push((node.moduleSpecifier as ts.StringLiteral).text);
        }
        if (ts.isCallExpression(node)) {
          expect(node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')).toBe(false);
        }
        ts.forEachChild(node, scan);
      }; scan(ast);
      for (const specifier of specifiers) {
        if (allowedNode.has(specifier)) continue;
        expect(specifier.startsWith('.')).toBe(true);
        const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
        const path = relative(root, target).replaceAll('\\', '/');
        expect(path.startsWith('src/dev/alpaca-iex/') || path.startsWith('src/dev/intraday-providers/') || pure.has(path)).toBe(true);
        await visit(target);
      }
    };
    for (const file of files) await visit(file);
    // Production must not begin importing this manually launched subsystem.
    const production = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (path === research || path === providers) continue;
        if (entry.isDirectory()) await production(path);
        else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
          const content = await readFile(path, 'utf8');
          expect(content).not.toContain('alpaca-iex/'); expect(content).not.toContain('intraday-providers/');
        }
      }
    };
    await production(resolve('src'));
  });
});
