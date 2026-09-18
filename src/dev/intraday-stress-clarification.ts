/** The three requested semantic comparisons only. Reads no database or provider. */
import { acuteClosingDownside, classify, classifyCurrentCollapse, recover, STATES, type Candidate, type Target } from './intraday-stress-calculation.js';

export const CLARIFICATION_VARIANTS = ['originalB', 'currentClose', 'absoluteHigh'] as const;
type Variant = typeof CLARIFICATION_VARIANTS[number];
type State = number | null;
export type ComparisonRow = {
  date: string; index: number; targetAt: string; spy: Target; rsp: Target;
  raw: Record<Variant, State>; effective: Record<Variant, State>;
};
const sessionCount = (rows: readonly ComparisonRow[]) => new Set(rows.map(r => r.date)).size;
const atLeastHigh = (value: State) => value !== null && value >= 2;
const pair = (a: State, b: State): State => a === null || b === null ? null : Math.max(a, b);
export function compareIntradaySemantics(targets: readonly Target[], b: Candidate) {
  const frozenB: Candidate = { name: 'B', shock: [0.4, 0.7], rolling: [0.45, 0.8], drawdown: [1, 1.75],
    acute: { ratio: 1.2, floor: 0.02, emergency: 0.03 }, session: { ratio: 2.5, floor: 0.025, emergency: 0.04 } };
  if (JSON.stringify(b) !== JSON.stringify(frozenB)) throw new Error('This clarification accepts only recorded Candidate B.');
  const byTarget = new Map<string, { spy?: Target; rsp?: Target }>();
  for (const t of targets) {
    if (t.closing || (t.symbol !== 'SPY' && t.symbol !== 'RSP')) continue;
    const key = `${t.date}:${t.index}`, slot = byTarget.get(key) ?? {}, symbol = t.symbol === 'SPY' ? 'spy' : 'rsp';
    if (slot[symbol]) throw new Error('Duplicate research target.');
    slot[symbol] = t; byTarget.set(key, slot);
  }
  const records: ComparisonRow[] = [...byTarget.values()].map(({ spy, rsp }) => {
    if (!spy || !rsp || spy.targetAt !== rsp.targetAt) throw new Error('Both aligned authoritative targets required.');
    const raw = {
      originalB: pair(classify(spy, b), classify(rsp, b)),
      currentClose: pair(classifyCurrentCollapse(spy, b), classifyCurrentCollapse(rsp, b)),
      absoluteHigh: pair(classifyCurrentCollapse(spy, b, true), classifyCurrentCollapse(rsp, b, true)),
    };
    if (Object.values(raw).some(s => (s === null) !== (raw.originalB === null))) throw new Error('Closing evidence changes availability; inspect cache.');
    return { date: spy.date, index: spy.index, targetAt: spy.targetAt, spy, rsp, raw, effective: { ...raw } };
  }).sort((a, z) => a.date.localeCompare(z.date) || a.index - z.index);
  const byDate = new Map<string, ComparisonRow[]>();
  for (const row of records) { const rows = byDate.get(row.date) ?? []; rows.push(row); byDate.set(row.date, rows); }
  for (const rows of byDate.values()) {
    if (rows.some((r, i) => r.index !== i + 1)) throw new Error('Expected target sequence must include gaps as unavailable.');
    for (const variant of CLARIFICATION_VARIANTS) {
      const values = recover(rows.map(r => r.raw[variant]), 2);
      rows.forEach((r, i) => { r.effective[variant] = values[i]!; });
    }
  }
  const valid = records.filter(r => r.raw.originalB !== null);
  const upgraded = valid.filter(r => !atLeastHigh(r.raw.currentClose) && r.raw.absoluteHigh === 2);
  const concern = valid.filter(r => !atLeastHigh(r.raw.originalB)
    && [r.spy, r.rsp].some(t => t.downsideExcursionPct! >= 0.01 || t.sessionDrawdownPct! >= 0.025));
  const unresolved = concern.filter(r => !atLeastHigh(r.raw.absoluteHigh));
  const resolved = concern.filter(r => atLeastHigh(r.raw.absoluteHigh));
  const removedSevere = valid.filter(r => r.raw.originalB === 3 && r.raw.currentClose !== 3);
  const newSevere = valid.filter(r => r.raw.originalB !== 3 && r.raw.currentClose === 3);
  if (newSevere.length || valid.some(r => (r.raw.currentClose === 3) !== (r.raw.absoluteHigh === 3))) throw new Error('Severe monotonicity/safeguard invariant failed.');
  const frequencies = (rows: ComparisonRow[], variant: Variant, kind: 'raw' | 'effective') => ({
    n: rows.length, counts: STATES.map((_, i) => rows.filter(r => r[kind][variant] === i).length),
    percentages: STATES.map((_, i) => rows.length ? rows.filter(r => r[kind][variant] === i).length / rows.length * 100 : null),
    severeSessions: sessionCount(rows.filter(r => r[kind][variant] === 3)),
  });
  const frequency = Object.fromEntries(CLARIFICATION_VARIANTS.map(v => [v, { raw: frequencies(valid, v, 'raw'), effective: frequencies(valid, v, 'effective') }]));
  const strata: [string, ComparisonRow[]][] = [
    ...[2021, 2022, 2023, 2024, 2025, 2026].map(y => [`year_${y}`, valid.filter(r => r.date.startsWith(String(y)))] as [string, ComparisonRow[]]),
    ['opening_1_4', valid.filter(r => r.index <= 4)], ['nonopening_5_plus', valid.filter(r => r.index > 4)],
    ['quiet_both_ATR_lt_1pct', valid.filter(r => Math.max(r.spy.priorAtr14Pct!, r.rsp.priorAtr14Pct!) < 0.01)],
    ['high_either_ATR_ge_2pct', valid.filter(r => Math.max(r.spy.priorAtr14Pct!, r.rsp.priorAtr14Pct!) >= 0.02)],
    ['middle_ATR', valid.filter(r => { const atr = Math.max(r.spy.priorAtr14Pct!, r.rsp.priorAtr14Pct!); return atr >= 0.01 && atr < 0.02; })],
  ];
  const byPeriod = Object.fromEntries(strata.map(([label, rows]) => [label, {
    upgrades: rows.filter(r => upgraded.includes(r)).length, affectedSessions: sessionCount(rows.filter(r => upgraded.includes(r))),
    raw: frequencies(rows, 'absoluteHigh', 'raw'), effective: frequencies(rows, 'absoluteHigh', 'effective'),
  }]));
  const reasons = (r: ComparisonRow) => ({ acute: [r.spy, r.rsp].some(t => acuteClosingDownside(t).acuteCloseDownsidePct! >= 0.01),
    drawdown: [r.spy, r.rsp].some(t => t.sessionDrawdownPct! >= 0.025) });
  const evidence = (r: ComparisonRow) => ({ date: r.date, index: r.index, targetAt: r.targetAt, raw: r.raw, effective: r.effective,
    spy: { ...r.spy, ...acuteClosingDownside(r.spy) }, rsp: { ...r.rsp, ...acuteClosingDownside(r.rsp) } });
  const severeDates = [...new Set(valid.filter(r => r.raw.originalB === 3).map(r => r.date))];
  const dates = [...new Set([...severeDates, '2021-12-02', '2021-12-07', '2024-12-18', '2025-04-07', '2025-10-10', '2025-11-20', '2026-06-09'])].sort();
  const bySevereDate = dates.map(date => {
    const rows = valid.filter(r => r.date === date);
    return { date, ...Object.fromEntries(CLARIFICATION_VARIANTS.map(v => [v, {
      rawSevere: rows.filter(r => r.raw[v] === 3).length, effectiveSevere: rows.filter(r => r.effective[v] === 3).length,
      maxRaw: rows.length ? STATES[Math.max(...rows.map(r => r.raw[v]!))] : null,
    }])) };
  });
  const unresolvedDates = new Set(unresolved.map(r => r.date));
  const summary = { comparison: 'Fixed Candidate B: original / current-close acute SEVERE / plus fixed absolute HIGH',
    validTargets: valid.length, unavailableTargets: records.length - valid.length, validSessions: sessionCount(valid),
    firstValid: valid[0]?.date, lastValid: valid.at(-1)?.date, frequency, byPeriod, bySevereDate,
    severeChange: { removed: removedSevere.map(evidence), new: newSevere.map(evidence),
      disappearedSessions: severeDates.filter(d => !valid.some(r => r.date === d && r.raw.currentClose === 3)),
      remainingSessions: severeDates.filter(d => valid.some(r => r.date === d && r.raw.currentClose === 3)) },
    safeguards: { upgradedTargets: upgraded.length, affectedSessions: sessionCount(upgraded), dates: [...new Set(upgraded.map(r => r.date))],
      acuteOnly: upgraded.filter(r => reasons(r).acute && !reasons(r).drawdown).length,
      drawdownOnly: upgraded.filter(r => !reasons(r).acute && reasons(r).drawdown).length,
      both: upgraded.filter(r => reasons(r).acute && reasons(r).drawdown).length,
      originalEffectiveAlreadyHigh: upgraded.filter(r => atLeastHigh(r.effective.originalB)).length,
      revisedEffectiveAlreadyHigh: upgraded.filter(r => atLeastHigh(r.effective.currentClose)).length,
      upgradedWithTriggerStillAboveOpen: upgraded.filter(r => [r.spy, r.rsp].some(t => t.openToCurrentPct! > 0 && (t.sessionDrawdownPct! >= 0.025 || acuteClosingDownside(t).acuteCloseDownsidePct! >= 0.01))).map(evidence) },
    absoluteConcern: { originalTargets: concern.length, originalSessions: sessionCount(concern), resolvedTargets: resolved.length,
      sessionsWithResolvedTargets: sessionCount(resolved), fullyResolvedSessions: [...new Set(concern.map(r => r.date))].filter(d => !unresolvedDates.has(d)).length,
      unresolvedTargets: unresolved.length, unresolvedSessions: sessionCount(unresolved), unresolved: unresolved.map(evidence) },
  };
  return { summary, records, upgraded, evidence };
}

export function renderClarificationTables(s: ReturnType<typeof compareIntradaySemantics>['summary']): string {
  const table = (heads: string[], rows: (string | number)[][]) => ['| ' + heads.join(' | ') + ' |', '| ' + heads.map(() => '---').join(' | ') + ' |', ...rows.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
  const pct = (n: number | null) => n === null ? 'N/A' : n.toFixed(4);
  const sections = ['## Final bounded semantic clarification\n',
    'Original Candidate B is preserved above. This comparison changes only acute SEVERE to current-close downside, then adds the fixed 1% acute-close / 2.5% session-drawdown HIGH safeguards. No other ladder or recovery rule is recalibrated. All counts below are market targets (SPY/RSP max), not instrument-targets. All effective states use two confirmations and reset at each session.\n',
    table(['Version', 'States', 'NORMAL n / %', 'ELEVATED n / %', 'HIGH n / %', 'SEVERE n / %', 'SEVERE sessions'], CLARIFICATION_VARIANTS.flatMap(v => (['raw', 'effective'] as const).map(k => {
      const d = s.frequency[v]![k]; return [v, k, ...d.counts.map((n, i) => `${n} / ${pct(d.percentages[i]!)}`), d.severeSessions];
    }))),
    '\n### Final behavior by period\n',
    'Percentages use each row’s valid-target denominator. Year 2021 and 2026 are partial. ATR categories are mutually exclusive: quiet means both below 1%; high means either at least 2%; middle is the remainder. Opening is indices 1–4.\n',
    table(['Period', 'n', 'Upgraded targets', 'Affected sessions', 'Raw N/E/H/S %', 'Effective N/E/H/S %'], Object.entries(s.byPeriod).map(([k, d]) => [k, d.raw.n, d.upgrades, d.affectedSessions, d.raw.percentages.map(pct).join(' / '), d.effective.percentages.map(pct).join(' / ')])),
    '\n### SEVERE sessions and requested checks\n',
    table(['Date', 'Original raw / effective SEVERE', 'Current-close raw / effective SEVERE', 'Final raw / effective SEVERE', 'Original / revised / final maximum raw'], s.bySevereDate.map(d => {
      const versions = CLARIFICATION_VARIANTS.map(v => (d as unknown as Record<string, { rawSevere: number; effectiveSevere: number; maxRaw: string }>)[v]!);
      return [d.date, ...versions.map(v => `${v.rawSevere} / ${v.effectiveSevere}`), versions.map(v => v.maxRaw).join(' / ')];
    })),
    '\n### Fixed safeguards and original concern set\n',
    `Safeguards upgrade **${s.safeguards.upgradedTargets} raw market targets across ${s.safeguards.affectedSessions} sessions** compared with current-close SEVERE alone. Acute-only: ${s.safeguards.acuteOnly}; drawdown-only: ${s.safeguards.drawdownOnly}; both: ${s.safeguards.both}. “Both” can involve different authoritative instruments.\n`,
    `Of the original **${s.absoluteConcern.originalTargets} targets / ${s.absoluteConcern.originalSessions} sessions**, ${s.absoluteConcern.resolvedTargets} targets reach HIGH, covering ${s.absoluteConcern.sessionsWithResolvedTargets} sessions; ${s.absoluteConcern.fullyResolvedSessions} sessions have every original concern resolved. ${s.absoluteConcern.unresolvedTargets} targets in ${s.absoluteConcern.unresolvedSessions} sessions remain below HIGH. The report explains why recovered-low-only observations should not all be upgraded.\n`,
    'Every upgraded target is retained in [semantic-high-upgrades.csv](semantic-high-upgrades.csv), with both instruments’ current and intrabar evidence and all raw/effective comparisons. [semantic-clarification.json](semantic-clarification.json) retains the removed SEVERE target, every unresolved concern, and above-open safeguard examples. Percentage fields in these artifacts are decimal fractions.\n',
  ];
  return sections.join('\n');
}
