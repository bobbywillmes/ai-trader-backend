import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyParticipation, PARTICIPATION_STATES } from './participation-classification.js';
import { analyzeParticipation, validateParticipationReport } from './participation-analysis.js';
import { analyzeParticipationFile, participationAnalysisMain } from './participation-analysis-runner.js';
import { compactSessionRanges, participationCoverage } from './participation-coverage.js';
import { fullSessionDates, panelDiagnostics, PARTICIPATION_SYMBOLS, type ParticipationDay } from './participation-calculation.js';
import { researchCalendar } from './intraday-stress-calendar.js';

const calendar = researchCalendar([]), dates = fullSessionDates('2024-01-01', '2024-04-30', calendar);
function fixture(values: (number | null)[], control = values) {
  const days: ParticipationDay[] = values.map((value, i) => ({ date: dates[i]!,
    etfs: Object.fromEntries(PARTICIPATION_SYMBOLS.map(s => [s, { normalizedTargetVolume: value === null ? null : value * 100,
      medianVolume20: 100, rvol20: value, medianVolume40: value !== null && control[i] ? value * 100 / control[i]! : null,
      rvol40: control[i] ?? null, baselineRatio: null,
      reasons20: value === null ? [`TARGET:${dates[i]}:MISSING_VOLUME`] : [], reasons40: control[i] === null ? ['MISSING'] : [] }])) as ParticipationDay['etfs'],
    panel20: value === null ? null : panelDiagnostics(Array(5).fill(value)),
    panel40: control[i] == null ? null : panelDiagnostics(Array(5).fill(control[i])), panel20Reasons: [], panel40Reasons: [] }));
  return { datasetId: 'a'.repeat(64), from: dates[0]!, to: dates[values.length - 1]!, evidenceFrom: '2023-10-02', calendar,
    definition: { version: 'participation-research-v1', symbols: [...PARTICIPATION_SYMBOLS], horizons: [20, 40],
      primary: 'Median of all five continuous RVOL values; equal sensors; direction-neutral.', tradingAuthority: false,
      normalizationThrough: dates[values.length - 1]!, volumeBasis: 'Massive unadjusted daily aggregate volume; full-length session dates only.' },
    days, providerGaps: [] as { symbol: string; kind: string; from: string; to: string; error: string }[] };
}
const temporary: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('frozen research classification', () => {
  it.each([[0, 'QUIET'], [0.749999999, 'QUIET'], [0.75, 'NORMAL'], [1.249999999, 'NORMAL'],
    [1.25, 'ACTIVE'], [1.499999999, 'ACTIVE'], [1.50, 'INTENSE']] as const)('classifies %s as %s', (value, state) => expect(classifyParticipation(value)).toBe(state));
  it.each([NaN, Infinity, -Infinity, -0.001])('rejects invalid value %s', value => expect(() => classifyParticipation(value)).toThrow());
  it('has no memory, confirmation or jump restriction', () => {
    for (const prior of [0.5, 1, 1.3, 2]) { classifyParticipation(prior); expect(classifyParticipation(1.6)).toBe('INTENSE'); }
    expect([0.5, 2, 0.5].map(classifyParticipation)).toEqual(['QUIET', 'INTENSE', 'QUIET']);
  });
});
describe('offline calibration diagnostics', () => {
  it('calculates exact distributions, matrices, runs and isolated-session RVOLs', () => {
    const r = analyzeParticipation(fixture([0.7, 1.6, 0.6, 1, 1, 1.3]));
    expect(r.stateDistribution.QUIET!.count).toBe(2); expect(r.stateDistribution.QUIET!.percentage).toBeCloseTo(100 / 3);
    expect(r.transitions).toMatchObject({ comparable: 5, stateChanges: 4 });
    expect(r.transitions.matrix.QUIET.INTENSE).toBe(1); expect(r.transitions.matrix.INTENSE.QUIET).toBe(1);
    expect(r.transitions.matrix.NORMAL.NORMAL).toBe(1); expect(r.transitions.changesOnlyMatrix.NORMAL.NORMAL).toBe(0);
    expect(r.runs.NORMAL).toMatchObject({ count: 1, totalSessions: 2, meanDuration: 2, medianDuration: 2, maxDuration: 2, oneDayRuns: 0, atMostTwoDayRuns: 1 });
    expect(r.oneDayRuns.QUIET).toMatchObject({ count: 2, minimumRvol: 0.6, maximumRvol: 0.7 });
    expect(r.oneDayRuns.QUIET!.medianRvol).toBeCloseTo(0.65);
    expect(r.representativeDays.INTENSE!.highest[0]!.agreement.ge150).toBe(5);
  });
  it('counts inclusive threshold bands without changing states', () => {
    const r = analyzeParticipation(fixture([0.74, 0.75, 0.76, 0.80]));
    expect(r.thresholdProximity[0]!.bands.map(b => b.count)).toEqual([3, 3, 4]);
    expect(r.stateDistribution.QUIET!.count).toBe(1);
  });
  it('computes control confusion and disagreement severity on paired valid dates', () => {
    const r = analyzeParticipation(fixture([0.7, 1, 1.3, 1.7], [0.7, 1.3, 1.7, 0.7]));
    expect(r.control40).toMatchObject({ pairedCount: 4, sameClassification: 1, agreementPercentage: 25, adjacentStateDisagreements: 2, multiLevelDisagreements: 1 });
    expect(r.control40.confusionMatrix.INTENSE.QUIET).toBe(1);
  });
  it('breaks runs/comparisons at missing or invalid panels without inferring missing raw evidence', () => {
    const report = fixture([1, null, 1, 1, 1]); report.days[3]!.panel20!.panelMedianRvol = -1;
    const r = analyzeParticipation(report);
    expect(r.validObservations).toBe(3); expect(r.transitions.comparable).toBe(0); expect(r.runs.NORMAL!.count).toBe(3);
    expect(r.evidenceCoverage.etfs.SPY!.missingExpectedSessionCount).toBe(1);
    expect(r.providerGaps).toEqual([]);
    report.days.splice(3, 1);
    expect(analyzeParticipation(report).transitions.comparable).toBe(0);
  });
  it('validates definition, all-five evidence and actual baseline horizon', () => {
    const report = fixture([1]); report.definition.symbols.pop();
    expect(() => analyzeParticipation(report)).toThrow('symbols');
    const horizon = fixture([1]); horizon.definition.horizons = [40, 20]; expect(() => analyzeParticipation(horizon)).toThrow('Incompatible');
    const arithmetic = fixture([1]); arithmetic.days[0]!.etfs.SPY.rvol20 = 2;
    expect(analyzeParticipation(arithmetic).validObservations).toBe(0);
    const baseline = fixture(Array(21).fill(1)); baseline.days[0]!.etfs.SPY.normalizedTargetVolume = 1000;
    for (let i = 1; i < 11; i++) baseline.days[i]!.etfs.SPY.normalizedTargetVolume = 1000;
    expect(validateParticipationReport(baseline).excludedPanels['20:BASELINE_WINDOW_MISMATCH']?.count).toBe(1);
  });
  it('keeps agreement/range out of classification', () => {
    const report = fixture([1.6]); report.days[0]!.panel20!.agreement.ge150 = NaN; report.days[0]!.panel20!.range = -1;
    expect(analyzeParticipation(report).stateDistribution.INTENSE!.count).toBe(1);
  });
  it('does not let malformed control measurements invalidate the independent 20-session candidate', () => {
    const report = fixture([1]); report.days[0]!.etfs.SPY.rvol40 = -1;
    const result = analyzeParticipation(report);
    expect(result.validObservations).toBe(1); expect(result.control40.pairedCount).toBe(0);
  });
  it('compacts missing eligible dates across weekends and separates request failures', () => {
    const ds = ['2024-01-05', '2024-01-08', '2024-01-09', '2024-01-10'];
    expect(compactSessionRanges(ds, new Set([ds[0]!, ds[1]!, ds[3]!]))).toEqual([
      { from: ds[0], to: ds[1], sessions: 2 }, { from: ds[3], to: ds[3], sessions: 1 }]);
    const report = fixture([null, null, 1]);
    const coverage = participationCoverage(report.days, report.from, report.to, calendar);
    expect(coverage.etfs.SPY!.missingRanges).toEqual([{ from: dates[0], to: dates[1], sessions: 2 }]);
    report.providerGaps.push({ symbol: 'SPY', kind: 'daily', from: report.from, to: report.to, error: 'REQUEST_FAILURE' });
    expect(analyzeParticipation(report).evidenceCoverage).toEqual(coverage);
    expect(analyzeParticipation(report).providerGaps).toHaveLength(1);
  });
  it('is deterministic, offline, and guards the source artifact', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'participation-analysis-')); temporary.push(dir);
    const input = path.join(dir, 'input.json'), output = path.join(dir, 'output.json');
    await writeFile(input, JSON.stringify(fixture([0.7, 1, 1.3, 1.7])));
    const fetch = vi.fn(() => { throw new Error('Forbidden provider access'); }); vi.stubGlobal('fetch', fetch);
    const first = await analyzeParticipationFile(input, output), bytes = await readFile(output, 'utf8');
    expect(await analyzeParticipationFile(input, output)).toEqual(first); expect(await readFile(output, 'utf8')).toBe(bytes);
    expect(fetch).not.toHaveBeenCalled(); await expect(analyzeParticipationFile(input, input)).rejects.toThrow('overwrite');
    await expect(participationAnalysisMain(['--fetch'])).rejects.toThrow();
    for (const name of ['participation-analysis', 'participation-analysis-runner', 'participation-classification', 'participation-coverage']) {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/(?:from|import\()['" ]+.*(?:db\/|integrations\/|research-runner|research-data|config\/env)/);
      expect(source).not.toMatch(/prisma|\$transaction|fetch\(/);
    }
    expect(Object.keys(first.stateDistribution)).toEqual([...PARTICIPATION_STATES]);
  });
});
