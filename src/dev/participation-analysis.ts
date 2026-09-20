/** Pure artifact analysis: no filesystem, provider, database, clock or trading access. */
import { z } from 'zod';
import { validDate } from '../services/market-calendar.js';
import { fullSessionDates, median, panelDiagnostics, PARTICIPATION_SYMBOLS, summarizeParticipation, type ParticipationDay } from './participation-calculation.js';
import { classifyParticipation, FROZEN_PARTICIPATION, PARTICIPATION_STATES, type ParticipationState } from './participation-classification.js';
import { participationCoverage, compactSessionRanges } from './participation-coverage.js';

const dateSchema = z.string().refine(validDate);
const numeric = z.number().finite().nonnegative();
const optionalMeasurement = numeric.nullable().catch(null);
const instrument = z.object({ normalizedTargetVolume: optionalMeasurement, medianVolume20: optionalMeasurement, rvol20: optionalMeasurement,
  medianVolume40: optionalMeasurement, rvol40: optionalMeasurement, baselineRatio: optionalMeasurement,
  reasons20: z.array(z.string()).catch(['INVALID_REPORT_REASONS']), reasons40: z.array(z.string()).catch(['INVALID_REPORT_REASONS']) });
// Stored diagnostic fields are never classification prerequisites; recompute them from five RVOLs.
const panel = z.object({ panelMedianRvol: numeric });
const reportSchema = z.object({ datasetId: z.string().regex(/^[a-f0-9]{64}$/), from: dateSchema, to: dateSchema, evidenceFrom: dateSchema,
  definition: z.object({ version: z.literal('participation-research-v1'), symbols: z.array(z.string()), horizons: z.tuple([z.literal(20), z.literal(40)]),
    primary: z.literal('Median of all five continuous RVOL values; equal sensors; direction-neutral.'), tradingAuthority: z.literal(false),
    normalizationThrough: dateSchema, volumeBasis: z.literal('Massive unadjusted daily aggregate volume; full-length session dates only.') }).passthrough(),
  calendar: z.array(z.object({ sessionDate: dateSchema, type: z.enum(['CLOSED', 'EARLY_CLOSE']), closeTimeMinutesEt: z.number().int().nullable() })),
  providerGaps: z.array(z.object({ symbol: z.string(), kind: z.string(), from: dateSchema, to: dateSchema, error: z.string() })),
  days: z.array(z.object({ date: dateSchema }).passthrough()),
});
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
const matrix = () => Object.fromEntries(PARTICIPATION_STATES.map(s => [s, Object.fromEntries(PARTICIPATION_STATES.map(t => [t, 0]))])) as Record<ParticipationState, Record<ParticipationState, number>>;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function validateParticipationReport(input: unknown) {
  const result = reportSchema.safeParse(input);
  if (!result.success) throw new Error(`Incompatible Participation research report: ${result.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ')}`);
  const report = result.data;
  if ([...report.definition.symbols].sort().join(',') !== [...PARTICIPATION_SYMBOLS].sort().join(',')
    || report.from > report.to || report.evidenceFrom > report.to || report.evidenceFrom < '2021-01-01' || report.to > '2026-12-31'
    || report.definition.normalizationThrough !== report.to) throw new Error('Incompatible Participation symbols/range/normalization definition.');
  const calendarDates = report.calendar.map(c => c.sessionDate);
  if (new Set(calendarDates).size !== calendarDates.length) throw new Error('Duplicate calendar exceptions.');
  const expected = fullSessionDates(report.from, report.to, report.calendar), expectedSet = new Set(expected);
  const rows = new Map(report.days.map(d => [d.date, d]));
  if (rows.size !== report.days.length || report.days.some((d, i) => !expectedSet.has(d.date) || (i > 0 && d.date <= report.days[i - 1]!.date))) throw new Error('Report dates must be unique, chronological eligible full sessions.');
  const excluded: Record<string, string[]> = {};
  const days: ParticipationDay[] = expected.map(date => {
    const row = rows.get(date);
    const etfs = Object.fromEntries(PARTICIPATION_SYMBOLS.map(s => {
      const raw = row?.etfs && typeof row.etfs === 'object' ? (row.etfs as Record<string, unknown>)[s] : undefined;
      const parsed = instrument.safeParse(raw);
      return [s, parsed.success ? parsed.data : { normalizedTargetVolume: null, medianVolume20: null, medianVolume40: null, rvol20: null, rvol40: null,
        baselineRatio: null, reasons20: ['INVALID_OR_MISSING_REPORT_EVIDENCE'], reasons40: ['INVALID_OR_MISSING_REPORT_EVIDENCE'] }];
    })) as ParticipationDay['etfs'];
    const day: ParticipationDay = { date, etfs, panel20: null, panel40: null, panel20Reasons: [], panel40Reasons: [] };
    for (const n of [20, 40] as const) {
      const parsed = panel.safeParse(row?.[`panel${n}`]);
      let reason = row?.[`panel${n}`] == null ? 'MISSING_OR_UNAVAILABLE_PANEL' : 'INVALID_PANEL';
      if (parsed.success) {
        const instrumentsValid = PARTICIPATION_SYMBOLS.map(s => {
          const e = etfs[s], v = e.normalizedTargetVolume, b = e[`medianVolume${n}`], r = e[`rvol${n}`];
          const valid = v !== null && b !== null && b > 0 && r !== null && e[`reasons${n}`].length === 0 && close(v / b, r);
          if (!valid) { e[`rvol${n}`] = null; e[`reasons${n}`] = [...e[`reasons${n}`], 'INVALID_REPORT_RVOL']; }
          return valid;
        }).every(Boolean);
        if (instrumentsValid) {
          const recomputed = panelDiagnostics(PARTICIPATION_SYMBOLS.map(s => etfs[s][`rvol${n}`]!));
          const p = parsed.data;
          if (close(p.panelMedianRvol, recomputed.panelMedianRvol)) {
            // Recompute diagnostic context; stored agreement/range never controls classification.
            day[`panel${n}`] = recomputed;
            reason = '';
          } else reason = 'PANEL_MEDIAN_MISMATCH';
        } else reason = 'INVALID_FIVE_ETF_RVOL';
      }
      if (reason) { (excluded[`${n}:${reason}`] ??= []).push(date); day[`panel${n}Reasons`] = [reason]; }
    }
    return day;
  });
  // Prove the horizon from actual preceding volumes wherever the artifact contains the full window.
  for (let i = 0; i < days.length; i++) for (const n of [20, 40] as const) {
    const day = days[i]!;
    if (!day[`panel${n}`] || i < n) continue;
    const valid = PARTICIPATION_SYMBOLS.map(s => {
      const volumes = days.slice(i - n, i).map(d => d.etfs[s].normalizedTargetVolume);
      const matches = volumes.every((v): v is number => v !== null) && close(median(volumes as number[])!, day.etfs[s][`medianVolume${n}`]!);
      if (!matches) { day.etfs[s][`rvol${n}`] = null; day.etfs[s][`reasons${n}`] = ['BASELINE_WINDOW_MISMATCH']; }
      return matches;
    }).every(Boolean);
    if (!valid) {
      day[`panel${n}`] = null; day[`panel${n}Reasons`] = ['BASELINE_WINDOW_MISMATCH'];
      (excluded[`${n}:BASELINE_WINDOW_MISMATCH`] ??= []).push(day.date);
    }
  }
  return { report, days, excludedPanels: Object.fromEntries(Object.entries(excluded).map(([reason, dates]) => [reason,
    { count: dates.length, ranges: compactSessionRanges(expected, new Set(dates)) }])) };
}

export function analyzeParticipation(input: unknown) {
  const { report, days, excludedPanels } = validateParticipationReport(input);
  const valid = days.flatMap(d => d.panel20 ? [{ date: d.date, state: classifyParticipation(d.panel20.panelMedianRvol), ...d.panel20 }] : []);
  const transitionMatrix = matrix(), changesMatrix = matrix(), confusionMatrix = matrix();
  const runs: { state: ParticipationState; from: string; to: string; values: number[] }[] = [];
  let previous: ParticipationState | null = null, comparable = 0, changes = 0;
  let run: typeof runs[number] | undefined;
  for (const d of days) {
    if (!d.panel20) { previous = null; run = undefined; continue; }
    const value = d.panel20.panelMedianRvol, state = classifyParticipation(value);
    if (previous !== null) { comparable++; transitionMatrix[previous][state]++; if (previous !== state) { changes++; changesMatrix[previous][state]++; } }
    if (run?.state === state) { run.to = d.date; run.values.push(value); }
    else { run = { state, from: d.date, to: d.date, values: [value] }; runs.push(run); }
    previous = state;
  }
  let paired = 0, same = 0, adjacent = 0, multiLevel = 0;
  for (const d of days) if (d.panel20 && d.panel40) {
    paired++;
    const a = classifyParticipation(d.panel20.panelMedianRvol), b = classifyParticipation(d.panel40.panelMedianRvol);
    confusionMatrix[a][b]++;
    const delta = Math.abs(PARTICIPATION_STATES.indexOf(a) - PARTICIPATION_STATES.indexOf(b));
    if (delta === 0) same++; else if (delta === 1) adjacent++; else multiLevel++;
  }
  return { analysisVersion: 'participation-calibration-v1', frozenDefinition: FROZEN_PARTICIPATION,
    sourceDatasetId: report.datasetId, analyzedRange: { from: report.from, to: report.to, evidenceFrom: report.evidenceFrom },
    validObservations: valid.length, unavailableObservations: days.length - valid.length,
    stateDistribution: Object.fromEntries(PARTICIPATION_STATES.map(s => { const count = valid.filter(d => d.state === s).length; return [s, { count, percentage: valid.length ? count / valid.length * 100 : null }]; })),
    transitions: { comparable, stateChanges: changes, annualizedChangesPer252Comparisons: comparable ? changes / comparable * 252 : null,
      matrix: transitionMatrix, changesOnlyMatrix: changesMatrix,
      directMultiLevelJumps: PARTICIPATION_STATES.flatMap((a, i) => PARTICIPATION_STATES.flatMap((b, j) => Math.abs(i - j) > 1 ? [{ from: a, to: b, count: transitionMatrix[a][b] }] : [])) },
    runs: Object.fromEntries(PARTICIPATION_STATES.map(s => {
      const selected = runs.filter(r => r.state === s), lengths = selected.map(r => r.values.length);
      return [s, { count: selected.length, totalSessions: lengths.reduce((a, b) => a + b, 0), meanDuration: mean(lengths), medianDuration: median(lengths),
        maxDuration: lengths.length ? Math.max(...lengths) : null, oneDayRuns: lengths.filter(n => n === 1).length, atMostTwoDayRuns: lengths.filter(n => n <= 2).length }];
    })),
    oneDayRuns: Object.fromEntries(PARTICIPATION_STATES.map(s => {
      const values = runs.filter(r => r.state === s && r.values.length === 1).map(r => r.values[0]!);
      return [s, { count: values.length, minimumRvol: values.length ? Math.min(...values) : null, medianRvol: median(values), maximumRvol: values.length ? Math.max(...values) : null }];
    })),
    thresholdProximity: [0.75, 1.25, 1.50].map(threshold => ({ threshold, bands: [0.01, 0.025, 0.05].map(halfWidth => ({ halfWidth,
      count: valid.filter(d => d.panelMedianRvol >= threshold - halfWidth && d.panelMedianRvol <= threshold + halfWidth).length })) })),
    representativeDays: Object.fromEntries(PARTICIPATION_STATES.map(s => {
      const sorted = valid.filter(d => d.state === s).sort((a, b) => a.panelMedianRvol - b.panelMedianRvol || a.date.localeCompare(b.date));
      return [s, { lowest: sorted.slice(0, 3), highest: sorted.slice(-3).reverse() }];
    })),
    control40: { pairedCount: paired, sameClassification: same, agreementPercentage: paired ? same / paired * 100 : null,
      adjacentStateDisagreements: adjacent, multiLevelDisagreements: multiLevel, confusionMatrix, continuousComparison: summarizeParticipation(days).comparison },
    evidenceCoverage: participationCoverage(days, report.from, report.to, report.calendar), providerGaps: report.providerGaps, excludedPanels,
    conventions: ['Transitions compare adjacent eligible full sessions only; unavailable/invalid/missing report rows break comparisons and runs.',
      'Runs include boundary/gap-censored runs. One-day diagnostics include these censored runs; no missing sessions are bridged.',
      'Annualized rate = state changes / comparable adjacent pairs * 252; descriptive, not a forecast.',
      'Threshold proximity uses inclusive bands and does not affect classification. Agreement/range is recomputed diagnostic context only.',
      '20/40 baselines are checked against preceding target volumes wherever a complete window is contained in the artifact; initial warmup outside the artifact relies on the recognized report definition and recorded baseline.',
      'Coverage for this legacy artifact is limited to the analyzed target range; normalized-volume absence alone does not prove missing raw evidence.',
      'Historical state never influences classification; rawState == effectiveState conceptually. No production publisher exists.'],
  };
}
