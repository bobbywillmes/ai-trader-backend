import { CANDIDATE_HORIZON_V2 } from './breadth-threshold-comparison.js';
import type { BreadthThresholdComparison } from './breadth-threshold-comparison.js';
import { BASELINE_BREADTH_BANDS, BREADTH_STATES, type BreadthState } from '../services/breadth-calculation.js';

const pct = (value: number) => `${value.toFixed(2)}%`;
const num = (value: number | null) => value === null ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(4);
function row(label: string, baseline: string, candidate: string): string { return `| ${label} | ${baseline} | ${candidate} |`; }

function distributionRows(b: Record<BreadthState, number>, c: Record<BreadthState, number>): string[] {
  return BREADTH_STATES.map(state => row(state, pct(b[state]), pct(c[state])));
}

export function renderBreadthThresholdComparisonReport(comparison: BreadthThresholdComparison): string {
  const lines: string[] = [];
  lines.push('# Breadth threshold comparison: BASELINE vs CANDIDATE_HORIZON_V2', '');
  lines.push('Controlled research comparison only. No provider (Massive) calls were made; both', 'runs read the same already-cached evidence. No MarketRegimeDimensionAssessment rows,', 'schema/migration, or trading behavior changed. Not a decision — evidence for the owner.', '');
  lines.push('## Definitions compared', '', '| Horizon | BASELINE negativeMax/positiveMin | CANDIDATE_HORIZON_V2 negativeMax/positiveMin |', '| --- | --- | --- |');
  for (const key of ['breadth1', 'breadth5', 'breadth20'] as const) {
    lines.push(row(key, `${BASELINE_BREADTH_BANDS[key].negativeMax}/${BASELINE_BREADTH_BANDS[key].positiveMin}`, `${CANDIDATE_HORIZON_V2[key].negativeMax}/${CANDIDATE_HORIZON_V2[key].positiveMin}`));
  }
  lines.push('', `Requested range: ${comparison.baseline.requestedRange.from} .. ${comparison.baseline.requestedRange.to}.`,
    `Provider requests made this run: grouped=${comparison.baseline.actualRequests.grouped + comparison.candidate.actualRequests.grouped}, universe=${comparison.baseline.actualRequests.universe + comparison.candidate.actualRequests.universe} (must be zero).`,
    'Underlying per-session observation evidence was verified identical between both runs before any comparison was computed.', '');

  lines.push('## 1. Effective state distribution', '');
  lines.push('| State | BASELINE overall | CANDIDATE overall |', '| --- | --- | --- |');
  for (const line of distributionRows(comparison.effectiveStateDistribution.baseline.percentages, comparison.effectiveStateDistribution.candidate.percentages)) lines.push(line);
  lines.push(`\n(${comparison.effectiveStateDistribution.baseline.sessions} classified sessions in both — the set of classified sessions does not depend on the band definition.)`, '');
  lines.push('| Year | BASELINE POSITIVE | BASELINE MIXED | BASELINE NEGATIVE | CANDIDATE POSITIVE | CANDIDATE MIXED | CANDIDATE NEGATIVE |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const year of Object.keys(comparison.effectiveStateDistribution.baselineByYear).sort()) {
    const b = comparison.effectiveStateDistribution.baselineByYear[year]!.percentages, c = comparison.effectiveStateDistribution.candidateByYear[year]!.percentages;
    lines.push(`| ${year} | ${pct(b.POSITIVE)} | ${pct(b.MIXED)} | ${pct(b.NEGATIVE)} | ${pct(c.POSITIVE)} | ${pct(c.MIXED)} | ${pct(c.NEGATIVE)} |`);
  }
  lines.push('');

  lines.push('## 2. Raw horizon classification distribution', '');
  for (const [key, title] of [['breadth1', '1-day'], ['breadth5', '5-day'], ['breadth20', '20-day']] as const) {
    const h = comparison.rawHorizonDistribution[key];
    lines.push(`### ${title} raw distribution`, '', '| State | BASELINE | CANDIDATE |', '| --- | --- | --- |');
    for (const line of distributionRows(h.baseline.percentages, h.candidate.percentages)) lines.push(line);
    lines.push('', `<details><summary>${title} by year</summary>`, '', '| Year | B-POS | B-MIX | B-NEG | C-POS | C-MIX | C-NEG |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const year of Object.keys(h.baselineByYear).sort()) {
      const b = h.baselineByYear[year]!.percentages, c = h.candidateByYear[year]!.percentages;
      lines.push(`| ${year} | ${pct(b.POSITIVE)} | ${pct(b.MIXED)} | ${pct(b.NEGATIVE)} | ${pct(c.POSITIVE)} | ${pct(c.MIXED)} | ${pct(c.NEGATIVE)} |`);
    }
    lines.push('', '</details>', '');
  }

  lines.push('## 3. Horizon agreement', '');
  lines.push('| Metric | BASELINE | CANDIDATE |', '| --- | --- | --- |');
  lines.push(row('All three agree', pct(comparison.horizonAgreement.baseline.allThreeAgreePct), pct(comparison.horizonAgreement.candidate.allThreeAgreePct)));
  lines.push(row('Exactly two of three agree', pct(comparison.horizonAgreement.baseline.twoOfThreeAgreePct), pct(comparison.horizonAgreement.candidate.twoOfThreeAgreePct)));
  lines.push(row('1d disagrees with both 5d and 20d', pct(comparison.horizonAgreement.baseline.oneDayOutlierPct), pct(comparison.horizonAgreement.candidate.oneDayOutlierPct)));
  lines.push(row('5d and 20d agree with each other', pct(comparison.horizonAgreement.fiveTwentyAgreePct.baseline), pct(comparison.horizonAgreement.fiveTwentyAgreePct.candidate)));
  for (const state of BREADTH_STATES) lines.push(row(`Both 5d and 20d ${state}`, pct(comparison.horizonAgreement.bothFiveTwenty[state].baseline), pct(comparison.horizonAgreement.bothFiveTwenty[state].candidate)));
  lines.push('');

  lines.push('## 4. Transition / run behavior', '');
  lines.push('| Metric | BASELINE | CANDIDATE |', '| --- | --- | --- |');
  const bt = comparison.transitions.baseline, ct = comparison.transitions.candidate;
  lines.push(row('Total transitions', String(bt.total), String(ct.total)));
  lines.push(row('Median run length', num(bt.medianRun), num(ct.medianRun)));
  lines.push(row('1-day runs', String(bt.oneDayRuns), String(ct.oneDayRuns)));
  lines.push(row('<=2-day runs', String(bt.twoDayOrShorterRuns), String(ct.twoDayOrShorterRuns)));
  for (const state of BREADTH_STATES) lines.push(row(`Longest ${state} run`, String(bt.longestRunByState[state]), String(ct.longestRunByState[state])));
  lines.push('');

  lines.push('## 5. Deterioration vs. recovery transitions', '');
  lines.push('| Metric | BASELINE | CANDIDATE |', '| --- | --- | --- |');
  lines.push(row('Immediate deterioration transitions', String(bt.deteriorationCount), String(ct.deteriorationCount)));
  lines.push(row('Confirmed recovery transitions', String(bt.recoveryCount), String(ct.recoveryCount)));
  lines.push('', 'By exact category (NEGATIVE -> POSITIVE and POSITIVE -> NEGATIVE-in-one-step-from-POSITIVE', 'are the only categories worth flagging specially):', '');
  const categoryKeys = [...new Set([...Object.keys(bt.categories), ...Object.keys(ct.categories)])].sort();
  lines.push('| Transition | BASELINE | CANDIDATE |', '| --- | --- | --- |');
  for (const key of categoryKeys) lines.push(row(key, String(bt.categories[key] ?? 0), String(ct.categories[key] ?? 0)));
  lines.push('', '`NEGATIVE -> POSITIVE` is structurally impossible under this hysteresis: recovery always', 'moves exactly one level, so NEGATIVE can only ever recover to MIXED first.', '');

  lines.push('## 6. Important market periods', '');
  for (const period of comparison.periods) {
    lines.push(`### ${period.label}`, '', '| Metric | BASELINE | CANDIDATE |', '| --- | --- | --- |');
    lines.push(row('POSITIVE %', pct(period.baseline.percentages.POSITIVE), pct(period.candidate.percentages.POSITIVE)));
    lines.push(row('MIXED %', pct(period.baseline.percentages.MIXED), pct(period.candidate.percentages.MIXED)));
    lines.push(row('NEGATIVE %', pct(period.baseline.percentages.NEGATIVE), pct(period.candidate.percentages.NEGATIVE)));
    lines.push(row('Transitions', String(period.baseline.transitions), String(period.candidate.transitions)));
    lines.push(row('Raw 1d POSITIVE/MIXED/NEGATIVE %', `${pct(period.baseline.breadth1.percentages.POSITIVE)}/${pct(period.baseline.breadth1.percentages.MIXED)}/${pct(period.baseline.breadth1.percentages.NEGATIVE)}`, `${pct(period.candidate.breadth1.percentages.POSITIVE)}/${pct(period.candidate.breadth1.percentages.MIXED)}/${pct(period.candidate.breadth1.percentages.NEGATIVE)}`));
    lines.push(row('Raw 5d POSITIVE/MIXED/NEGATIVE %', `${pct(period.baseline.breadth5.percentages.POSITIVE)}/${pct(period.baseline.breadth5.percentages.MIXED)}/${pct(period.baseline.breadth5.percentages.NEGATIVE)}`, `${pct(period.candidate.breadth5.percentages.POSITIVE)}/${pct(period.candidate.breadth5.percentages.MIXED)}/${pct(period.candidate.breadth5.percentages.NEGATIVE)}`));
    lines.push(row('Raw 20d POSITIVE/MIXED/NEGATIVE %', `${pct(period.baseline.breadth20.percentages.POSITIVE)}/${pct(period.baseline.breadth20.percentages.MIXED)}/${pct(period.baseline.breadth20.percentages.NEGATIVE)}`, `${pct(period.candidate.breadth20.percentages.POSITIVE)}/${pct(period.candidate.breadth20.percentages.MIXED)}/${pct(period.candidate.breadth20.percentages.NEGATIVE)}`));
    lines.push('');
  }

  lines.push('## 7. Strongest daily breadth (evidence-stability check)', '');
  lines.push(comparison.strongestDailyUnchanged
    ? 'Confirmed unchanged: the strongest positive/negative daily `advanceShare` sessions are identical between BASELINE and CANDIDATE_HORIZON_V2 — thresholds affect classification only, not the underlying daily evidence.'
    : '**MISMATCH**: the strongest daily sessions differ between definitions, which should be impossible if only thresholds changed. Investigate before trusting any other section of this report.');
  lines.push('');

  lines.push('## 8. Dates whose effective state changed', '');
  lines.push(`**${comparison.changedDates.length}** of ${comparison.baseline.days.length} session dates (${pct(comparison.changedDates.length / comparison.baseline.days.length * 100)}) have a different effective state under CANDIDATE_HORIZON_V2.`, '');
  lines.push('| Change (baseline -> candidate) | Count |', '| --- | --- |');
  for (const [key, count] of comparison.changedDateCategoryCounts) lines.push(`| ${key} | ${count} |`);
  lines.push('', 'Representative sample (first 15 changed dates):', '', '| Date | BASELINE effective | CANDIDATE effective |', '| --- | --- | --- |');
  const sample = comparison.changedDates.slice(0, 15);
  for (const change of sample) lines.push(`| ${change.date} | ${change.from ?? 'n/a'} | ${change.to ?? 'n/a'} |`);
  lines.push('');

  return lines.join('\n');
}
