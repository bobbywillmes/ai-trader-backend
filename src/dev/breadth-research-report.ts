import type { BreadthResearchReport } from './breadth-research-runner.js';

/** Renders the concise Markdown behavior report described in the Breadth research pass.
 * Pure formatting only; every number here comes from `summarizeBreadth`. */
const pct = (value: number) => `${value.toFixed(2)}%`;
const num = (value: number | null) => value === null ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(4);

export function renderBreadthMarkdownReport(report: BreadthResearchReport): string {
  const { summary, definition, requestedRange, actualRequests, providerGaps, calendarExceptions, warnings } = report;
  const lines: string[] = [];
  lines.push('# Breadth (BREADTH) candidate calibration report', '');
  lines.push('Research/calibration evidence only. No authoritative assessments, no trading effect.', '');

  lines.push('## Available data', '');
  lines.push(`- Requested range: ${requestedRange.from} .. ${requestedRange.to}`);
  lines.push(`- Actual range: ${summary.availableDateRange.first ?? 'n/a'} .. ${summary.availableDateRange.last ?? 'n/a'}`);
  lines.push(`- Expected market sessions: ${summary.expectedSessions}`);
  lines.push(`- Valid breadth observations: ${summary.validObservations}`);
  lines.push(`- Unavailable observations: ${summary.unavailableObservations} (provider gaps: ${summary.providerGaps}; zero-directional: ${summary.zeroDirectionalDays})`);
  lines.push(`- Days without a classification (warm-up or gap): ${summary.unavailableClassificationDays}`);
  lines.push(`- Calendar exceptions in scope: ${calendarExceptions.length}`);
  if (providerGaps.length) {
    lines.push('', '| Date | Kind | Error |', '| --- | --- | --- |');
    for (const gap of providerGaps.slice(0, 30)) lines.push(`| ${gap.date} | ${gap.kind} | ${gap.error} |`);
    if (providerGaps.length > 30) lines.push(`| ... | ... | (${providerGaps.length - 30} more) |`);
  }
  lines.push('', `Actual provider requests this run: grouped=${actualRequests.grouped}, universe(estimated pages)=${actualRequests.universe}.`, '');

  lines.push('## Universe quality', '');
  const uq = summary.universeQuality;
  lines.push('| Metric | Min | Median | Max |', '| --- | --- | --- | --- |',
    `| Point-in-time CS universe count | ${num(uq.universeCount.min)} | ${num(uq.universeCount.median)} | ${num(uq.universeCount.max)} |`,
    `| Eligible directional count | ${num(uq.directionalCount.min)} | ${num(uq.directionalCount.median)} | ${num(uq.directionalCount.max)} |`,
    `| Excluded count | ${num(uq.excludedCount.min)} | ${num(uq.excludedCount.median)} | ${num(uq.excludedCount.max)} |`, '');
  if (uq.discontinuities.length) {
    lines.push(`${uq.discontinuities.length} day(s) with a >10% day-over-day universe-size swing (heuristic flag, not authoritative):`, '');
    lines.push('| Date | Previous count | Count |', '| --- | --- | --- |');
    for (const d of uq.discontinuities.slice(0, 20)) lines.push(`| ${d.date} | ${d.previousUniverseCount} | ${d.universeCount} |`);
    lines.push('');
  } else {
    lines.push('No day-over-day universe-size swing exceeded the 10% heuristic flag.', '');
  }

  lines.push('## Raw daily breadth', '');
  lines.push(`- Overall mean advanceShare: ${num(summary.rawDailyBreadth.mean)}`);
  lines.push(`- Overall median advanceShare: ${num(summary.rawDailyBreadth.median)}`, '');
  lines.push('Strongest positive daily sessions:', '', '| Date | advanceShare | netBreadth |', '| --- | --- | --- |');
  for (const day of summary.rawDailyBreadth.strongestPositive) lines.push(`| ${day.date} | ${num(day.advanceShare)} | ${num(day.netBreadth)} |`);
  lines.push('', 'Strongest negative daily sessions:', '', '| Date | advanceShare | netBreadth |', '| --- | --- | --- |');
  for (const day of summary.rawDailyBreadth.strongestNegative) lines.push(`| ${day.date} | ${num(day.advanceShare)} | ${num(day.netBreadth)} |`);
  lines.push('');

  lines.push('## Effective state distribution', '');
  lines.push(`Overall (${summary.effectiveStateDistribution.validSessions} classified sessions): ` +
    `POSITIVE ${pct(summary.effectiveStateDistribution.percentages.POSITIVE)}, ` +
    `MIXED ${pct(summary.effectiveStateDistribution.percentages.MIXED)}, ` +
    `NEGATIVE ${pct(summary.effectiveStateDistribution.percentages.NEGATIVE)}`, '');
  lines.push('| Year | Sessions | POSITIVE | MIXED | NEGATIVE | Mean adv. share | Median adv. share | Transitions |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [year, row] of Object.entries(summary.effectiveStateDistribution.byYear).sort()) {
    lines.push(`| ${year} | ${row.validSessions} | ${pct(row.percentages.POSITIVE)} | ${pct(row.percentages.MIXED)} | ${pct(row.percentages.NEGATIVE)} | ${num(row.meanAdvanceShare)} | ${num(row.medianAdvanceShare)} | ${row.transitions} |`);
  }
  lines.push('');

  lines.push('## Run / transition behavior', '');
  lines.push(`- Total transitions: ${summary.transitionCount}`);
  lines.push(`- Total runs: ${summary.runCount}`);
  lines.push(`- Median run duration (valid sessions): ${num(summary.medianRunDuration)}`);
  lines.push(`- 1-session runs: ${summary.oneDayRuns}`);
  lines.push(`- <=2-session runs: ${summary.twoDayOrShorterRuns}`, '');
  lines.push('All transitions:', '', '| Date | Previous effective | Raw | New effective | breadth1 | breadth5 | breadth20 |',
    '| --- | --- | --- | --- | --- | --- | --- |');
  for (const t of summary.transitions) {
    lines.push(`| ${t.date} | ${t.previousEffective ?? 'n/a'} | ${t.raw ?? 'n/a'} | ${t.effective ?? 'n/a'} | ${num(t.breadth1?.value ?? null)} (${t.breadth1?.state ?? 'n/a'}) | ${num(t.breadth5?.value ?? null)} (${t.breadth5?.state ?? 'n/a'}) | ${num(t.breadth20?.value ?? null)} (${t.breadth20?.state ?? 'n/a'}) |`);
  }
  lines.push('');

  lines.push('## Horizon agreement', '');
  if (summary.horizonAgreement) {
    lines.push(`- Eligible sessions (all three horizons available): ${summary.horizonAgreement.eligibleSessions}`);
    lines.push(`- All three agree: ${pct(summary.horizonAgreement.allThreeAgreePct)}`);
    lines.push(`- Exactly two of three agree: ${pct(summary.horizonAgreement.twoOfThreeAgreePct)}`);
    lines.push(`- 1-day disagrees with both 5d and 20d (which agree with each other): ${pct(summary.horizonAgreement.oneDayOutlierPct)}`);
  } else {
    lines.push('No session had all three horizons available.');
  }
  lines.push('');

  lines.push('## Definition frozen for this candidate run', '', '```json', JSON.stringify(definition, null, 2), '```', '');
  lines.push('## Notes', '');
  for (const warning of warnings) lines.push(`- ${warning}`);
  lines.push('');
  return lines.join('\n');
}
