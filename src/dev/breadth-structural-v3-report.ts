import { CANDIDATE_HORIZON_V2 } from './breadth-threshold-comparison.js';
import type { BreadthStructuralV3Comparison } from './breadth-structural-v3-comparison.js';
import { BASELINE_BREADTH_BANDS, BREADTH_STATES, CANDIDATE_STRUCTURAL_V3_BANDS, type BreadthState } from '../services/breadth-calculation.js';
import type { Distribution } from './breadth-threshold-comparison.js';

const pct = (value: number) => `${value.toFixed(2)}%`;
const num = (value: number | null) => value === null ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(4);
function row(...cells: string[]): string { return `| ${cells.join(' | ')} |`; }
function distributionRows(a: Distribution, b: Distribution, c: Distribution): string[] {
  return BREADTH_STATES.map(state => row(state, pct(a.percentages[state]), pct(b.percentages[state]), pct(c.percentages[state])));
}

export function renderBreadthStructuralV3Report(comparison: BreadthStructuralV3Comparison): string {
  const lines: string[] = [];
  lines.push('# Breadth structural candidate (STRUCTURAL_V3) vs BASELINE and CANDIDATE_HORIZON_V2', '');
  lines.push('Controlled research comparison of exactly three fixed definitions. No provider (Massive)', 'calls were made; all three runs read the same already-cached evidence, verified identical', 'before any comparison was computed. Not a decision — evidence for the owner. Not permission', 'to search further thresholds.', '');

  lines.push('## Definitions compared', '', '| Horizon | BASELINE | CANDIDATE_HORIZON_V2 | CANDIDATE_STRUCTURAL_V3 |', '| --- | --- | --- | --- |');
  for (const key of ['breadth1', 'breadth5', 'breadth20'] as const) {
    lines.push(row(key, `${BASELINE_BREADTH_BANDS[key].negativeMax}/${BASELINE_BREADTH_BANDS[key].positiveMin}`,
      `${CANDIDATE_HORIZON_V2[key].negativeMax}/${CANDIDATE_HORIZON_V2[key].positiveMin}`,
      `${CANDIDATE_STRUCTURAL_V3_BANDS[key].negativeMax}/${CANDIDATE_STRUCTURAL_V3_BANDS[key].positiveMin}`));
  }
  lines.push('', 'Raw aggregation: BASELINE and CANDIDATE_HORIZON_V2 use median-of-three; CANDIDATE_STRUCTURAL_V3',
    'uses 5d/20d-structural agreement with 1d as confirmation-only (never a tie-breaker, never', 'directional alone). Deterioration: BASELINE/V2 move immediately to the raw state;', 'STRUCTURAL_V3 moves immediately but only one effective level per valid assessment.', '');
  lines.push(`Requested range: ${comparison.baseline.requestedRange.from} .. ${comparison.baseline.requestedRange.to}.`,
    `Provider requests made this run: grouped=${comparison.baseline.actualRequests.grouped + comparison.v2.actualRequests.grouped + comparison.v3.actualRequests.grouped}, universe=${comparison.baseline.actualRequests.universe + comparison.v2.actualRequests.universe + comparison.v3.actualRequests.universe} (must be zero).`,
    'Underlying per-session observation evidence was verified identical across all three runs before any comparison was computed.', '');

  lines.push('## 1. Raw horizon classification distribution (CANDIDATE_STRUCTURAL_V3)', '');
  for (const [key, title] of [['breadth1', '1-day'], ['breadth5', '5-day'], ['breadth20', '20-day']] as const) {
    const h = comparison.rawHorizonDistributionV3[key];
    lines.push(`### ${title}`, '', '| State | % |', '| --- | --- |');
    for (const state of BREADTH_STATES) lines.push(row(state, pct(h.overall.percentages[state])));
    lines.push('', `<details><summary>${title} by year</summary>`, '', '| Year | POSITIVE | MIXED | NEGATIVE |', '| --- | --- | --- | --- |');
    for (const year of Object.keys(h.byYear).sort()) {
      const d = h.byYear[year]!.percentages;
      lines.push(row(year, pct(d.POSITIVE), pct(d.MIXED), pct(d.NEGATIVE)));
    }
    lines.push('', '</details>', '');
  }

  lines.push('## 2. Raw aggregated state distribution (pre-hysteresis)', '');
  lines.push('| State | BASELINE | V2 | STRUCTURAL_V3 |', '| --- | --- | --- | --- |');
  for (const line of distributionRows(comparison.rawAggregateDistribution.baseline.overall, comparison.rawAggregateDistribution.v2.overall, comparison.rawAggregateDistribution.v3.overall)) lines.push(line);
  lines.push('');

  lines.push('## 3. Effective state distribution', '');
  lines.push('| State | BASELINE | V2 | STRUCTURAL_V3 |', '| --- | --- | --- | --- |');
  for (const line of distributionRows(comparison.effectiveStateDistribution.baseline.overall, comparison.effectiveStateDistribution.v2.overall, comparison.effectiveStateDistribution.v3.overall)) lines.push(line);
  lines.push('', '| Year | BASE-POS | BASE-MIX | BASE-NEG | V2-POS | V2-MIX | V2-NEG | V3-POS | V3-MIX | V3-NEG |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const year of Object.keys(comparison.effectiveStateDistribution.baseline.byYear).sort()) {
    const b = comparison.effectiveStateDistribution.baseline.byYear[year]!.percentages;
    const v2 = comparison.effectiveStateDistribution.v2.byYear[year]!.percentages;
    const v3 = comparison.effectiveStateDistribution.v3.byYear[year]!.percentages;
    lines.push(row(year, pct(b.POSITIVE), pct(b.MIXED), pct(b.NEGATIVE), pct(v2.POSITIVE), pct(v2.MIXED), pct(v2.NEGATIVE), pct(v3.POSITIVE), pct(v3.MIXED), pct(v3.NEGATIVE)));
  }
  lines.push('');

  lines.push('## 4. Transition / run behavior', '');
  lines.push('| Metric | BASELINE | V2 | STRUCTURAL_V3 |', '| --- | --- | --- | --- |');
  const t = comparison.transitions;
  lines.push(row('Total transitions', String(t.baseline.total), String(t.v2.total), String(t.v3.total)));
  lines.push(row('Median run length', num(t.baseline.medianRun), num(t.v2.medianRun), num(t.v3.medianRun)));
  lines.push(row('Mean run length', num(t.baseline.meanRun), num(t.v2.meanRun), num(t.v3.meanRun)));
  lines.push(row('1-day runs', String(t.baseline.oneDayRuns), String(t.v2.oneDayRuns), String(t.v3.oneDayRuns)));
  lines.push(row('<=2-day runs', String(t.baseline.twoDayOrShorterRuns), String(t.v2.twoDayOrShorterRuns), String(t.v3.twoDayOrShorterRuns)));
  for (const state of BREADTH_STATES) lines.push(row(`Longest ${state} run (STRUCTURAL_V3)`, '-', '-', String(t.v3.longestRunByState[state])));
  lines.push('');

  lines.push('## 5. Direct POSITIVE -> NEGATIVE effective flips', '');
  lines.push('| Metric | BASELINE | V2 | STRUCTURAL_V3 |', '| --- | --- | --- | --- |');
  lines.push(row('POSITIVE -> NEGATIVE', String(comparison.directPositiveNegativeFlips.baseline), String(comparison.directPositiveNegativeFlips.v2), String(comparison.directPositiveNegativeFlips.v3)));
  for (const key of ['POSITIVE -> MIXED', 'MIXED -> NEGATIVE', 'NEGATIVE -> MIXED', 'MIXED -> POSITIVE'] as const) {
    lines.push(row(key, String(t.baseline.categories[key] ?? 0), String(t.v2.categories[key] ?? 0), String(t.v3.categories[key] ?? 0)));
  }
  lines.push('', 'STRUCTURAL_V3\'s `POSITIVE -> NEGATIVE` count is asserted to be exactly zero by the', 'comparison tool itself (it throws before reporting anything otherwise), matching the', 'one-level-per-assessment deterioration rule.', '');

  lines.push('## 6. Raw 5d/20d structural agreement (STRUCTURAL_V3)', '');
  const sa = comparison.structuralAgreementV3;
  lines.push('| Metric | % | Sessions |', '| --- | --- | --- |');
  lines.push(row('Both 5d and 20d POSITIVE', pct(sa.bothPositivePct), '-'));
  lines.push(row('Both 5d and 20d NEGATIVE', pct(sa.bothNegativePct), '-'));
  lines.push(row('Both 5d and 20d MIXED', pct(sa.bothMixedPct), '-'));
  lines.push(row('5d/20d opposite (raw MIXED, 1d cannot break tie)', pct(sa.oppositePct), '-'));
  lines.push(row('Exactly one directional + one MIXED', pct(sa.oneDirectionalOneMixedPct), String(sa.oneDirectionalOneMixedSessions)));
  lines.push('', `Of those "one directional + one MIXED" sessions, 1-day confirmed the directional`,
    `reading **${sa.confirmedByOneDay}** times (${pct(sa.confirmedByOneDayPct)}) and did not confirm it`,
    `**${sa.notConfirmedByOneDay}** times (${pct(100 - sa.confirmedByOneDayPct)}) — those non-confirmations`, 'become raw MIXED rather than directional.', '');

  lines.push('## 7. Important market periods', '');
  for (const period of comparison.periods) {
    lines.push(`### ${period.label}`, '', '| Metric | BASELINE | V2 | STRUCTURAL_V3 |', '| --- | --- | --- | --- |');
    lines.push(row('POSITIVE %', pct(period.baseline.percentages.POSITIVE), pct(period.v2.percentages.POSITIVE), pct(period.v3.percentages.POSITIVE)));
    lines.push(row('MIXED %', pct(period.baseline.percentages.MIXED), pct(period.v2.percentages.MIXED), pct(period.v3.percentages.MIXED)));
    lines.push(row('NEGATIVE %', pct(period.baseline.percentages.NEGATIVE), pct(period.v2.percentages.NEGATIVE), pct(period.v3.percentages.NEGATIVE)));
    lines.push(row('Transitions', String(period.baseline.transitions), String(period.v2.transitions), String(period.v3.transitions)));
    lines.push(row('STRUCTURAL_V3 raw 1d POS/MIX/NEG %', '-', '-', `${pct(period.v3.breadth1.percentages.POSITIVE)}/${pct(period.v3.breadth1.percentages.MIXED)}/${pct(period.v3.breadth1.percentages.NEGATIVE)}`));
    lines.push(row('STRUCTURAL_V3 raw 5d POS/MIX/NEG %', '-', '-', `${pct(period.v3.breadth5.percentages.POSITIVE)}/${pct(period.v3.breadth5.percentages.MIXED)}/${pct(period.v3.breadth5.percentages.NEGATIVE)}`));
    lines.push(row('STRUCTURAL_V3 raw 20d POS/MIX/NEG %', '-', '-', `${pct(period.v3.breadth20.percentages.POSITIVE)}/${pct(period.v3.breadth20.percentages.MIXED)}/${pct(period.v3.breadth20.percentages.NEGATIVE)}`));
    lines.push('');
  }

  lines.push('## 8. Dates whose effective state changed', '');
  lines.push(`**STRUCTURAL_V3 vs BASELINE:** ${comparison.changedVsBaseline.changedDates.length} of ${comparison.baseline.days.length} session dates (${pct(comparison.changedVsBaseline.changedDates.length / comparison.baseline.days.length * 100)}).`, '');
  lines.push('| Change (BASELINE -> STRUCTURAL_V3) | Count |', '| --- | --- |');
  for (const [key, count] of comparison.changedVsBaseline.categoryCounts) lines.push(row(key, String(count)));
  lines.push('', 'Representative sample (first 15 changed dates, BASELINE vs STRUCTURAL_V3):', '', '| Date | BASELINE | STRUCTURAL_V3 |', '| --- | --- | --- |');
  for (const change of comparison.changedVsBaseline.changedDates.slice(0, 15)) lines.push(row(change.date, change.from ?? 'n/a', change.to ?? 'n/a'));
  lines.push('', `**STRUCTURAL_V3 vs CANDIDATE_HORIZON_V2:** ${comparison.changedVsV2.changedDates.length} of ${comparison.v2.days.length} session dates (${pct(comparison.changedVsV2.changedDates.length / comparison.v2.days.length * 100)}).`, '');
  lines.push('| Change (V2 -> STRUCTURAL_V3) | Count |', '| --- | --- |');
  for (const [key, count] of comparison.changedVsV2.categoryCounts) lines.push(row(key, String(count)));
  lines.push('');

  lines.push('## 9. Strongest daily breadth (evidence-stability check)', '');
  lines.push(comparison.strongestDailyUnchanged
    ? 'Confirmed unchanged across all three definitions: the strongest positive/negative daily `advanceShare` sessions are identical — classification/aggregation/hysteresis changes never touch the underlying daily evidence.'
    : '**MISMATCH**: the strongest daily sessions differ between definitions, which should be impossible. Investigate before trusting any other section of this report.');
  lines.push('');

  return lines.join('\n');
}
