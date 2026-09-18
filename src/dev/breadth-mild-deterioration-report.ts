import { BREADTH_STATES } from '../services/breadth-calculation.js';
import type { BreadthMildDeteriorationComparison } from './breadth-mild-deterioration-comparison.js';

const pct = (value: number) => `${value.toFixed(2)}%`;
const num = (value: number | null) => value === null ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(4);
function row(...cells: string[]): string { return `| ${cells.join(' | ')} |`; }

export function renderBreadthMildDeteriorationReport(comparison: BreadthMildDeteriorationComparison): string {
  const lines: string[] = [];
  lines.push('# Breadth hysteresis experiment: STRUCTURAL_V3_MILD_DETERIORATION_CONFIRMATION', '');
  lines.push('Hysteresis-only experiment. Thresholds and raw aggregation are unchanged from', 'CANDIDATE_STRUCTURAL_V3 — this variant replays a different effective-state rule over the', 'identical, unmodified STRUCTURAL_V3 raw-state sequence. No provider (Massive) calls were', 'made; not a decision, not permission to try a fifth definition.', '');

  lines.push('## 1. Raw-state identity', '');
  lines.push('Confirmed: the mild-deterioration variant\'s raw-state sequence is read directly from', '`CANDIDATE_STRUCTURAL_V3`\'s own `days[].rawState` (never recomputed), and the comparison tool', 'asserts byte-identical equality before reporting anything else. Only effective states differ.', '');

  lines.push('## 2. Effective state distribution', '');
  lines.push('| State | BASELINE | CANDIDATE_HORIZON_V2 | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |', '| --- | --- | --- | --- | --- |');
  const esd = comparison.effectiveStateDistribution;
  for (const state of BREADTH_STATES) {
    lines.push(row(state, pct(esd.baseline.overall.percentages[state]), pct(esd.v2.overall.percentages[state]), pct(esd.v3.overall.percentages[state]), pct(esd.mild.overall.percentages[state])));
  }
  lines.push('', '| Year | V3-POS | V3-MIX | V3-NEG | MILD-POS | MILD-MIX | MILD-NEG |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const year of Object.keys(esd.v3.byYear).sort()) {
    const v3y = esd.v3.byYear[year]!.percentages, mildY = esd.mild.byYear[year]!.percentages;
    lines.push(row(year, pct(v3y.POSITIVE), pct(v3y.MIXED), pct(v3y.NEGATIVE), pct(mildY.POSITIVE), pct(mildY.MIXED), pct(mildY.NEGATIVE)));
  }
  lines.push('');

  lines.push('## 3. Transition / run behavior', '');
  lines.push('| Metric | BASELINE | V2 | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |', '| --- | --- | --- | --- | --- |');
  const t = comparison.transitions;
  lines.push(row('Total transitions', String(t.baseline.total), String(t.v2.total), String(t.v3.total), String(t.mild.total)));
  lines.push(row('Median run length', num(t.baseline.medianRun), num(t.v2.medianRun), num(t.v3.medianRun), num(t.mild.medianRun)));
  lines.push(row('Mean run length', num(t.baseline.meanRun), num(t.v2.meanRun), num(t.v3.meanRun), num(t.mild.meanRun)));
  lines.push(row('1-day runs', String(t.baseline.oneDayRuns), String(t.v2.oneDayRuns), String(t.v3.oneDayRuns), String(t.mild.oneDayRuns)));
  lines.push(row('<=2-day runs', String(t.baseline.twoDayOrShorterRuns), String(t.v2.twoDayOrShorterRuns), String(t.v3.twoDayOrShorterRuns), String(t.mild.twoDayOrShorterRuns)));
  lines.push('');

  lines.push('## 4. Transition pairs', '');
  lines.push('| Transition | BASELINE | V2 | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |', '| --- | --- | --- | --- | --- |');
  for (const key of ['POSITIVE -> MIXED', 'MIXED -> POSITIVE', 'MIXED -> NEGATIVE', 'NEGATIVE -> MIXED', 'POSITIVE -> NEGATIVE', 'NEGATIVE -> POSITIVE'] as const) {
    lines.push(row(key, String(t.baseline.categories[key] ?? 0), String(t.v2.categories[key] ?? 0), String(t.v3.categories[key] ?? 0), String(t.mild.categories[key] ?? 0)));
  }
  lines.push('', `Direct POSITIVE -> NEGATIVE is asserted to be exactly zero for the mild variant (${comparison.directPositiveNegativeFlips.mild}) — the comparison tool throws before reporting anything otherwise.`, '');

  lines.push('## 5. Mild-deterioration diagnostic', '');
  const d = comparison.mildDeteriorationDiagnostic;
  lines.push('| Metric | Count |', '| --- | --- |');
  lines.push(row('Effective POSITIVE encountered raw MIXED', String(d.encounteredMixedFromPositive)));
  lines.push(row('...of which: first-day mild-deterioration hold (stayed POSITIVE)', String(d.firstDayHolds)));
  lines.push(row('...of which: second consecutive raw MIXED (transitioned to MIXED)', String(d.secondMixedTransitionedToMixed)));
  lines.push(row('Raw returned to POSITIVE before a second MIXED (reset the hold)', String(d.returnedToPositiveBeforeSecondMixed)));
  lines.push(row('Raw became NEGATIVE from POSITIVE (immediate drop to MIXED, no mild delay)', String(d.negativeCausedImmediateDropToMixed)));
  lines.push('');

  lines.push('## 6. Genuine-negative response speed', '');
  const n = comparison.negativeResponseSpeed;
  lines.push('| Metric | Count | Verified |', '| --- | --- | --- |');
  lines.push(row('POSITIVE + raw NEGATIVE -> same-assessment MIXED', String(n.immediateDropCount), `${n.immediateDropVerified}/${n.immediateDropCount}`));
  lines.push(row('...followed by a next-valid-assessment raw NEGATIVE -> effective NEGATIVE', String(n.sustainedNegativeCount), `${n.sustainedNegativeVerified}/${n.sustainedNegativeCount}`));
  lines.push('', 'No confirmation delay was observed for genuine raw NEGATIVE evidence at any point (both', 'counts fully verified above; the comparison tool throws otherwise rather than reporting).', '');

  lines.push('## 7. Recovery behavior', '');
  lines.push('| Metric | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |', '| --- | --- | --- |');
  lines.push(row('NEGATIVE -> MIXED', String(t.v3.categories['NEGATIVE -> MIXED'] ?? 0), String(t.mild.categories['NEGATIVE -> MIXED'] ?? 0)));
  lines.push(row('MIXED -> POSITIVE', String(t.v3.categories['MIXED -> POSITIVE'] ?? 0), String(t.mild.categories['MIXED -> POSITIVE'] ?? 0)));
  lines.push('', 'Every transitioned mild-variant day is asserted to move exactly one severity level (the', 'comparison tool throws otherwise), so no recovery ever occurs on one supporting session and', 'none ever jumps two states — enforced structurally, not just observed.', '');

  lines.push('## 8. Important market periods (STRUCTURAL_V3 vs MILD_DETERIORATION_CONFIRMATION)', '');
  for (const period of comparison.periods) {
    lines.push(`### ${period.label}`, '', '| Metric | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |', '| --- | --- | --- |');
    lines.push(row('POSITIVE %', pct(period.v3.percentages.POSITIVE), pct(period.mild.percentages.POSITIVE)));
    lines.push(row('MIXED %', pct(period.v3.percentages.MIXED), pct(period.mild.percentages.MIXED)));
    lines.push(row('NEGATIVE %', pct(period.v3.percentages.NEGATIVE), pct(period.mild.percentages.NEGATIVE)));
    lines.push(row('Transitions', String(period.v3.transitions), String(period.mild.transitions)));
    lines.push('');
  }

  lines.push('## 9. Dates whose effective state changed (MILD_DETERIORATION_CONFIRMATION vs STRUCTURAL_V3)', '');
  const total = comparison.v3.days.length;
  lines.push(`**${comparison.changedVsV3.changedDates.length}** of ${total} session dates (${pct(comparison.changedVsV3.changedDates.length / total * 100)}) changed.`, '');
  lines.push('| Change (STRUCTURAL_V3 -> MILD_DETERIORATION_CONFIRMATION) | Count |', '| --- | --- |');
  for (const [key, count] of comparison.changedVsV3.categoryCounts) lines.push(row(key, String(count)));
  lines.push('', 'Representative sample (first 15 changed dates):', '', '| Date | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |', '| --- | --- | --- |');
  for (const change of comparison.changedVsV3.changedDates.slice(0, 15)) lines.push(row(change.date, change.from ?? 'n/a', change.to ?? 'n/a'));
  lines.push('');

  lines.push('## 10. Longest runs', '');
  lines.push('| State | STRUCTURAL_V3 | MILD_DETERIORATION_CONFIRMATION |', '| --- | --- | --- |');
  for (const state of BREADTH_STATES) lines.push(row(state, String(t.v3.longestRunByState[state]), String(t.mild.longestRunByState[state])));
  lines.push('');

  return lines.join('\n');
}
