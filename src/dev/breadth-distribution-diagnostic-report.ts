import { HORIZON_KEYS, type BreadthDistributionDiagnostic, type HorizonKey } from './breadth-distribution-diagnostic.js';
import type { Distribution } from './breadth-statistics.js';

const HORIZON_TITLES: Record<HorizonKey, string> = { breadth1: '1-day', breadth5: '5-day', breadth20: '20-day' };
const num = (value: number | null, digits = 4): string => value === null ? 'n/a' : value.toFixed(digits);
const pct = (value: number | null, digits = 2): string => value === null ? 'n/a' : `${value.toFixed(digits)}%`;
function row(...cells: string[]): string { return `| ${cells.join(' | ')} |`; }

function distributionRow(label: string, d: Distribution): string {
  return row(label, String(d.count), num(d.mean), num(d.median), num(d.stddev), num(d.min), num(d.max), num(d.p10), num(d.p25), num(d.p75), num(d.p90));
}

export function renderBreadthDistributionDiagnosticReport(diagnostic: BreadthDistributionDiagnostic): string {
  const lines: string[] = [];
  lines.push('# Breadth distribution diagnostic', '');
  lines.push('Descriptive-only diagnostic. No thresholds proposed or tested, no classifier or', 'hysteresis change, no BREADTH_V1 decision. No provider (Massive) calls were made this run', '(asserted below). Reuses the already-cached, already-computed Breadth measurements from the', 'prior calibration and threshold-comparison passes.', '');
  lines.push(`Requested range: ${diagnostic.requestedRange.from} .. ${diagnostic.requestedRange.to}.`,
    `Provider requests made this run: grouped=${diagnostic.actualRequests.grouped}, universe=${diagnostic.actualRequests.universe} (must be zero).`,
    `Sessions considered: ${diagnostic.sessionsConsidered}.`, '', `**Convention:** ${diagnostic.statisticsConvention}`, '');

  lines.push('## 1. Overall distribution', '');
  lines.push('| Horizon | Count | Mean | Median | Stddev | Min | Max | P10 | P25 | P75 | P90 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const key of HORIZON_KEYS) lines.push(distributionRow(HORIZON_TITLES[key], diagnostic.horizons[key].overall));
  lines.push('');

  lines.push('## 2. Yearly distribution', '');
  for (const key of HORIZON_KEYS) {
    lines.push(`### ${HORIZON_TITLES[key]}`, '', '| Year | Count | Mean | Median | P10 | P25 | P75 | P90 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    const byYear = diagnostic.horizons[key].byYear;
    for (const year of Object.keys(byYear).sort()) {
      const d = byYear[year]!;
      lines.push(row(year, String(d.count), num(d.mean), num(d.median), num(d.p10), num(d.p25), num(d.p75), num(d.p90)));
    }
    lines.push('');
  }

  lines.push('## 3. Centering diagnostic', '');
  lines.push('| Horizon | Mean - 0.50 | Median - 0.50 | <0.45 | [0.45,0.50) | ==0.50 | (0.50,0.55) | >=0.55 | %<0.50 | %>0.50 | %==0.50 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const key of HORIZON_KEYS) {
    const c = diagnostic.horizons[key].centering;
    lines.push(row(HORIZON_TITLES[key], num(c.meanOffsetFrom50), num(c.medianOffsetFrom50),
      pct(c.bandPercentages.below45), pct(c.bandPercentages.from45to50), pct(c.bandPercentages.exactly50),
      pct(c.bandPercentages.from50to55), pct(c.bandPercentages.atOrAbove55),
      pct(c.belowAboveEqual.belowPct), pct(c.belowAboveEqual.abovePct), pct(c.belowAboveEqual.equalPct)));
  }
  lines.push('', '| Horizon | within 49/51 | within 48/52 | within 47/53 | within 45/55 |', '| --- | --- | --- | --- | --- |');
  for (const key of HORIZON_KEYS) {
    const w = diagnostic.horizons[key].centering.withinBand;
    lines.push(row(HORIZON_TITLES[key], pct(w.p49_51), pct(w.p48_52), pct(w.p47_53), pct(w.p45_55)));
  }
  lines.push('');

  lines.push('## 4. Horizon compression', '');
  lines.push('| Metric | 1-day | 5-day | 20-day |', '| --- | --- | --- | --- |');
  lines.push(row('Standard deviation', num(diagnostic.compression.stddev.breadth1), num(diagnostic.compression.stddev.breadth5), num(diagnostic.compression.stddev.breadth20)));
  lines.push(row('IQR (P75 - P25)', num(diagnostic.compression.iqr.breadth1), num(diagnostic.compression.iqr.breadth5), num(diagnostic.compression.iqr.breadth20)));
  lines.push('', `5-day stddev / 1-day stddev: **${num(diagnostic.compression.ratio5over1)}**. 20-day stddev / 1-day stddev: **${num(diagnostic.compression.ratio20over1)}**.`, '');

  lines.push('## 5. Relationship between horizons', '');
  lines.push('| Pair | Paired sessions | Pearson correlation | Mean absolute difference |', '| --- | --- | --- | --- |');
  const r = diagnostic.relationships;
  lines.push(row('breadth1 vs breadth5', String(r.breadth1_breadth5.pairedSessions), num(r.breadth1_breadth5.correlation), num(r.breadth1_breadth5.meanAbsDiff)));
  lines.push(row('breadth1 vs breadth20', String(r.breadth1_breadth20.pairedSessions), num(r.breadth1_breadth20.correlation), num(r.breadth1_breadth20.meanAbsDiff)));
  lines.push(row('breadth5 vs breadth20', String(r.breadth5_breadth20.pairedSessions), num(r.breadth5_breadth20.correlation), num(r.breadth5_breadth20.meanAbsDiff)));
  lines.push('');

  lines.push('## 6. Shape summary (histogram buckets)', '');
  for (const key of HORIZON_KEYS) {
    lines.push(`### ${HORIZON_TITLES[key]}`, '', '| Bucket | Count | % |', '| --- | --- | --- |');
    for (const bucket of diagnostic.horizons[key].histogram) lines.push(row(bucket.label, String(bucket.count), pct(bucket.pct)));
    lines.push('');
  }

  lines.push('## 7. Important market periods', '');
  for (const period of diagnostic.periods) {
    lines.push(`### ${period.label}`, '', '| Horizon | Count | Mean | Median | P25 | P75 |', '| --- | --- | --- | --- | --- | --- |');
    for (const key of HORIZON_KEYS) {
      const s = period[key];
      lines.push(row(HORIZON_TITLES[key], String(s.count), num(s.mean), num(s.median), num(s.p25), num(s.p75)));
    }
    lines.push('');
  }

  return lines.join('\n');
}
