import { hash, SYMBOLS, valueHash, values } from './model.js';
import type { Observation, Symbol, Values } from './model.js';
import type { SessionPlan } from './session.js';

export type MinuteState = { symbol: Symbol; minuteStartAt: string; observations: Observation[]; selected: Observation;
  versions: Observation[]; ambiguous: boolean; initialMissing: boolean; duplicateCount: number; correctionCount: number };
export function replay(observations: readonly Observation[], cutoff: string): Map<string, MinuteState> {
  const limit = Date.parse(cutoff);
  if (!Number.isFinite(limit)) throw new Error('Invalid replay cutoff');
  const states = new Map<string, MinuteState>();
  const ordered = [...observations].sort((a, b) => a.ordinal - b.ordinal);
  if (new Set(ordered.map(o => o.runId)).size > 1 || new Set(ordered.map(o => o.ordinal)).size !== ordered.length) throw new Error('Replay requires one run with unique ordinals');
  for (const o of ordered) {
    if (Date.parse(o.receivedAt) > limit) continue;
    const key = `${o.symbol}/${o.minuteStartAt}`;
    const prior = states.get(key);
    if (!prior) { states.set(key, { symbol: o.symbol, minuteStartAt: o.minuteStartAt, observations: [o], selected: o,
      versions: [o], ambiguous: false, initialMissing: o.messageType === 'u', duplicateCount: 0, correctionCount: 0 }); continue; }
    const previousInitial = prior.observations.find(p => p.messageType === 'b');
    const identical = prior.observations.some(p => p.payloadHash === o.payloadHash);
    if (identical) prior.duplicateCount++;
    if (o.messageType === 'b') {
      if (previousInitial && previousInitial.payloadHash !== o.payloadHash) prior.ambiguous = true;
      prior.initialMissing = false;
      // Late initial evidence cannot downgrade an update; conflicting initials remain unresolved.
    } else {
      if (prior.selected.connectionEpoch !== o.connectionEpoch && prior.selected.payloadHash !== o.payloadHash) prior.ambiguous = true;
      const changed = valueHash(prior.selected) !== valueHash(o);
      if (changed) { prior.correctionCount++; prior.versions.push(o); }
      prior.selected = o;
    }
    prior.observations.push(o);
  }
  return states;
}
export type WindowState = { symbol: Symbol; startAt: string; targetAt: string; actionableTarget: boolean;
  completeness: 'INCOMPLETE' | 'COMPLETE_INITIAL' | 'COMPLETE_AFTER_UPDATE'; ambiguous: boolean;
  initialMissing: boolean; missingMinutes: string[]; aggregate: Values | null;
  constituents: { minuteStartAt: string; ordinal: number; connectionEpoch: number; payloadHash: string }[]; hash: string };
export function windows(states: Map<string, MinuteState>, plan: SessionPlan): WindowState[] {
  const output: WindowState[] = [];
  const open = Date.parse(plan.openAt), close = Date.parse(plan.closeAt);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open || (close - open) % 900_000) throw new Error('Invalid session plan');
  for (const symbol of SYMBOLS) for (let start = open; start < close; start += 900_000) {
    const expected = Array.from({ length: 15 }, (_, i) => new Date(start + i * 60_000).toISOString());
    const slots = expected.map(t => states.get(`${symbol}/${t}`));
    const present = slots.filter((s): s is MinuteState => !!s);
    const missingMinutes = expected.filter((_, i) => !slots[i]);
    const aggregate: Values | null = missingMinutes.length ? null : {
      open: present[0]!.selected.open, high: Math.max(...present.map(s => s.selected.high)),
      low: Math.min(...present.map(s => s.selected.low)), close: present[14]!.selected.close,
      volume: present.reduce((sum, s) => sum + s.selected.volume, 0),
    };
    if (aggregate && !Number.isSafeInteger(aggregate.volume)) throw new Error('Unsafe aggregate volume');
    const completeness = missingMinutes.length ? 'INCOMPLETE' : present.some(s => s.selected.messageType === 'u') ? 'COMPLETE_AFTER_UPDATE' : 'COMPLETE_INITIAL';
    const ambiguous = present.some(s => s.ambiguous);
    const initialMissing = present.some(s => s.initialMissing);
    output.push({ symbol, startAt: new Date(start).toISOString(), targetAt: new Date(start + 900_000).toISOString(),
      actionableTarget: start + 900_000 < close, completeness, ambiguous, initialMissing, missingMinutes, aggregate,
      constituents: present.map(s => ({ minuteStartAt: s.minuteStartAt, ordinal: s.selected.ordinal,
        connectionEpoch: s.selected.connectionEpoch, payloadHash: s.selected.payloadHash })),
      hash: hash({ aggregate, completeness, ambiguous, initialMissing, missingMinutes,
        constituentValues: present.map(s => s.selected.payloadHash) }) });
  }
  return output;
}
export function minuteMetrics(state: MinuteState) {
  const initial = state.observations.find(o => o.messageType === 'b');
  const updates = state.observations.filter(o => o.messageType === 'u');
  const minuteEnd = Date.parse(state.minuteStartAt) + 60_000;
  const first = state.observations[0]!;
  const latest = state.selected;
  return { ...state, minuteEndAt: new Date(minuteEnd).toISOString(), initialBarReceivedAt: initial?.receivedAt ?? null,
    initialLatencyMs: initial ? Date.parse(initial.receivedAt) - minuteEnd : null,
    firstObservationLatencyMs: Date.parse(first.receivedAt) - minuteEnd,
    firstUpdateReceivedAt: updates[0]?.receivedAt ?? null, lastUpdateReceivedAt: updates.at(-1)?.receivedAt ?? null,
    updateCount: updates.length, updateLatenciesMs: updates.map(o => Date.parse(o.receivedAt) - minuteEnd),
    correctionLagsMs: state.versions.slice(1).map(o => Date.parse(o.receivedAt) - Date.parse(first.receivedAt)),
    lastValueChangingCorrectionAt: state.versions.length > 1 ? state.versions.at(-1)!.receivedAt : null,
    ohlcChanged: state.versions.some(o => ['open', 'high', 'low', 'close'].some(k => o[k as keyof Values] !== first[k as keyof Values])),
    volumeChanged: state.versions.some(o => o.volume !== first.volume),
    initialToSelectedDelta: initial ? delta(values(initial), values(latest)) : null,
  };
}
export function delta(a: Values, b: Values) {
  return { open: b.open - a.open, high: b.high - a.high, low: b.low - a.low, close: b.close - a.close, volume: b.volume - a.volume };
}
