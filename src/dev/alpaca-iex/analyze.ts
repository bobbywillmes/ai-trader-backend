import { AGGREGATOR_VERSION, SYMBOLS, hash } from './model.js';
import type { Observation, ResearchEvent } from './model.js';
import type { Manifest } from './journal.js';
import { delta, minuteMetrics, replay, windows } from './replay.js';
import type { WindowState } from './replay.js';

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : null;
  return { count: sorted.length, negativeCount: sorted.filter(v => v < 0).length, median: quantile(.5), p90: quantile(.9), p95: quantile(.95), p99: quantile(.99), max: sorted.at(-1) ?? null };
}
export function analyze(identity: Manifest, observations: Observation[], events: ResearchEvent[], cutoff: string) {
  const limit = Date.parse(cutoff);
  if (!Number.isFinite(limit)) throw new Error('Invalid analysis cutoff');
  const known = observations.filter(o => Date.parse(o.receivedAt) <= limit).sort((a, b) => a.ordinal - b.ordinal);
  const knownEvents = events.filter(e => Date.parse(e.at) <= limit);
  const states = replay(known, cutoff);
  const finalWindows = windows(states, identity.session);
  const minutes = [...states.values()].map(minuteMetrics);
  const key = (w: WindowState) => `${w.symbol}/${w.startAt}`;
  const histories = new Map<string, { at: string; state: WindowState }[]>();
  // Process receipt groups once. Same-frame elements share availability; no synthetic micro-order in UTC.
  const times = [...new Set(known.map(o => o.receivedAt))].sort();
  for (const at of times) {
    const prefix = replay(known, at);
    for (const state of windows(prefix, identity.session)) {
      if (!state.constituents.length) continue;
      const history = histories.get(key(state)) ?? [];
      if (history.at(-1)?.state.hash !== state.hash) history.push({ at, state });
      histories.set(key(state), history);
    }
  }
  const windowReports = finalWindows.map(w => {
    const versions = histories.get(key(w)) ?? [];
    const firstComplete = versions.find(v => v.state.aggregate !== null && !v.state.ambiguous);
    const constituents = [...states.values()].filter(s => s.symbol === w.symbol && s.minuteStartAt >= w.startAt && s.minuteStartAt < w.targetAt);
    const initials = constituents.map(s => s.observations.find(o => o.messageType === 'b'));
    const firstAllInitialAt = initials.length === 15 && initials.every(Boolean) ? new Date(Math.max(...initials.map(o => Date.parse(o!.receivedAt)))).toISOString() : null;
    const updates = constituents.flatMap(s => s.observations.filter(o => o.messageType === 'u'));
    const lastUpdate = updates.length ? new Date(Math.max(...updates.map(o => Date.parse(o.receivedAt)))).toISOString() : null;
    const corrections = constituents.flatMap(s => s.versions.slice(1));
    const lastCorrection = corrections.length ? new Date(Math.max(...corrections.map(o => Date.parse(o.receivedAt)))).toISOString() : null;
    const correctionRepresentedAt = w.aggregate && !w.ambiguous ? new Date(Math.max(...constituents.map(s => Date.parse(s.versions.at(-1)!.receivedAt)))).toISOString() : null;
    const target = Date.parse(w.targetAt);
    const initialAggregate = firstAllInitialAt ? windows(replay(initials.filter((o): o is Observation => !!o), firstAllInitialAt), identity.session).find(x => key(x) === key(w))!.aggregate : null;
    // Subscription history is a coverage diagnostic, never an assertion of correction finality.
    const coverageEnd = limit;
    const before = knownEvents.filter(e => Date.parse(e.at) <= Date.parse(w.startAt));
    const connectionAtOpen = [...before].reverse().find(e => ['subscription_confirmed', 'socket_closed', 'socket_error', 'shutdown_requested'].includes(e.type));
    const gaps = knownEvents.filter(e => ['socket_closed', 'socket_error', 'reconnect_scheduled', 'shutdown_requested'].includes(e.type)
      && Date.parse(e.at) >= Date.parse(w.startAt) && Date.parse(e.at) <= coverageEnd);
    return { ...w, versions, firstAllInitialAt, firstCompleteAt: firstComplete?.at ?? null,
      firstCompleteLatencyMs: firstComplete ? Date.parse(firstComplete.at) - target : null,
      correctionsRepresentedAt: correctionRepresentedAt, lastUpdateAt: lastUpdate,
      latestCorrectionLatencyMs: lastCorrection ? Date.parse(lastCorrection) - target : null,
      latestCorrectionOffsetFromTargetMs: lastCorrection ? Date.parse(lastCorrection) - target : null,
      lastValueChangingCorrectionAt: lastCorrection,
      correctedConstituentMinutes: constituents.filter(s => s.correctionCount > 0).length,
      initialAggregate, initialToLatestDelta: initialAggregate && w.aggregate ? delta(initialAggregate, w.aggregate) : null,
      changedAfterFirstComplete: !!firstComplete && versions.some(v => v.at > firstComplete.at && v.state.hash !== firstComplete.state.hash),
      transportCoverage: connectionAtOpen?.type === 'subscription_confirmed' && !gaps.length ? 'NO_RECORDED_GAP' : 'UNCERTAIN',
      gapEvents: gaps, observationHorizonMs: limit - target, rightCensoredAtFiveMinutes: limit < target + 300_000,
    };
  });
  const candidateCutoffs = [30, 60, 90, 120, 300].map(seconds => {
    const snapshots = finalWindows.map(w => {
      const boundary = new Date(Date.parse(w.targetAt) + seconds * 1_000).toISOString();
      const candidate = windows(replay(known, new Date(Math.min(Date.parse(boundary), limit)).toISOString()), identity.session).find(c => key(c) === key(w))!;
      const censored = Date.parse(boundary) > limit;
      return { symbol: w.symbol, targetAt: w.targetAt, censored, complete: !censored && candidate.aggregate !== null && !candidate.ambiguous,
        changedLater: !censored && candidate.hash !== w.hash, hash: candidate.hash };
    });
    const perSymbol = Object.fromEntries(SYMBOLS.map(symbol => {
      const rows = snapshots.filter(w => w.symbol === symbol);
      return [symbol, { scheduled: rows.length, complete: rows.filter(w => w.complete).length, censored: rows.filter(w => w.censored).length,
        uncensoredScheduledWindows: rows.filter(w => !w.censored).length,
        uncensoredCompleteWindows: rows.filter(w => w.complete).length,
        uncensoredCompletePct: rows.some(w => !w.censored) ? 100 * rows.filter(w => w.complete).length / rows.filter(w => !w.censored).length : null,
        changedLater: rows.filter(w => w.changedLater).length }];
    }));
    const targets = [...new Set(snapshots.map(w => w.targetAt))];
    return { seconds, perSymbol, paired: { scheduled: targets.length,
      complete: targets.filter(t => snapshots.filter(w => w.targetAt === t).every(w => w.complete)).length }, snapshots };
  });
  const eventCounts = Object.fromEntries([...new Set(knownEvents.map(e => e.type))].map(type => [type, knownEvents.filter(e => e.type === type).length]));
  const inSession = (o: { minuteStartAt: string }) => o.minuteStartAt >= identity.session.openAt && o.minuteStartAt < identity.session.closeAt;
  const expectedMinutes = (Date.parse(identity.session.closeAt) - Date.parse(identity.session.openAt)) / 60_000;
  const horizonStart = Math.max(Date.parse(identity.session.openAt), Math.ceil(Date.parse(identity.startedAt) / 60_000) * 60_000);
  const horizonEnd = Math.min(Date.parse(identity.session.closeAt), Math.floor(limit / 60_000) * 60_000);
  const elapsedExpectedMinutes = Math.max(0, (horizonEnd - horizonStart) / 60_000);
  const uncensored = windowReports.filter(w => Date.parse(w.startAt) >= horizonStart && Date.parse(w.targetAt) <= horizonEnd);
  const clockUncertain = knownEvents.some(e => e.type === 'clock_jump');
  const reconnectGaps: { from: string; to: string | null; durationMs: number | null }[] = [];
  let gapStart: string | undefined;
  for (const event of knownEvents) {
    if (['socket_closed', 'socket_error', 'reconnect_scheduled'].includes(event.type)) gapStart ??= event.at;
    if (event.type === 'subscription_confirmed' && gapStart) {
      reconnectGaps.push({ from: gapStart, to: event.at, durationMs: Date.parse(event.at) - Date.parse(gapStart) }); gapStart = undefined;
    }
  }
  if (gapStart) reconnectGaps.push({ from: gapStart, to: null, durationMs: null });
  const subscriptionLatencies = knownEvents.filter(e => e.type === 'subscription_confirmed').flatMap(e => {
    const connected = knownEvents.find(c => c.connectionEpoch === e.connectionEpoch && c.type === 'socket_connected');
    return connected ? [Date.parse(e.at) - Date.parse(connected.at)] : [];
  });
  return { authority: 'RESEARCH_ONLY', analyzerVersion: AGGREGATOR_VERSION, manifest: identity, cutoff,
    observationHash: hash(observations), clockUncertain, latencyEligible: !clockUncertain,
    counts: { observations: known.length, bars: known.filter(o => o.messageType === 'b').length,
      updatedBars: known.filter(o => o.messageType === 'u').length,
      perSymbol: Object.fromEntries(SYMBOLS.map(symbol => [symbol, known.filter(o => o.symbol === symbol).length])),
      ignoredExtendedOrOtherSession: known.filter(o => !inSession(o)).length,
      malformed: eventCounts.malformed_frame ?? 0, unexpectedSymbols: eventCounts.unexpected_symbol ?? 0,
      unexpectedChannels: eventCounts.unexpected_channel ?? 0, duplicates: minutes.reduce((n, m) => n + m.duplicateCount, 0),
      corrections: minutes.reduce((n, m) => n + m.correctionCount, 0) },
    minuteCompleteness: Object.fromEntries(SYMBOLS.map(symbol => { const selected = minutes.filter(m => m.symbol === symbol && inSession(m));
      return [symbol, { expected: expectedMinutes, observed: selected.length, missing: expectedMinutes - selected.length,
        elapsedExpectedMinutes,
        elapsedObservedMinutes: selected.filter(m => Date.parse(m.minuteStartAt) >= horizonStart && Date.parse(m.minuteStartAt) < horizonEnd).length,
        elapsedMissingMinutes: elapsedExpectedMinutes - selected.filter(m => Date.parse(m.minuteStartAt) >= horizonStart && Date.parse(m.minuteStartAt) < horizonEnd).length,
        elapsedCoveragePct: elapsedExpectedMinutes ? 100 * selected.filter(m => Date.parse(m.minuteStartAt) >= horizonStart && Date.parse(m.minuteStartAt) < horizonEnd).length / elapsedExpectedMinutes : null,
        initialMissing: selected.filter(m => m.initialMissing).length, ambiguous: selected.filter(m => m.ambiguous).length }]; })),
    windowCompleteness: { scheduled: windowReports.length, complete: windowReports.filter(w => w.aggregate && !w.ambiguous).length,
      uncensoredScheduledWindows: uncensored.length,
      uncensoredCompleteWindows: uncensored.filter(w => w.aggregate && !w.ambiguous).length,
      uncensoredCompletePct: uncensored.length ? 100 * uncensored.filter(w => w.aggregate && !w.ambiguous).length / uncensored.length : null,
      incomplete: windowReports.filter(w => !w.aggregate).length, ambiguous: windowReports.filter(w => w.ambiguous).length },
    eventCounts, reconnectGaps, connectionEvents: knownEvents.filter(e => !['malformed_frame', 'unexpected_symbol', 'unexpected_channel'].includes(e.type)),
    latencyMs: { initial: distribution(minutes.flatMap(m => m.initialLatencyMs === null ? [] : [m.initialLatencyMs])),
      updates: distribution(minutes.flatMap(m => m.updateLatenciesMs)),
      correctionLag: distribution(minutes.flatMap(m => m.correctionLagsMs)),
      subscription: distribution(subscriptionLatencies), reconnectDowntime: distribution(reconnectGaps.flatMap(g => g.durationMs === null ? [] : [g.durationMs])),
      firstComplete: distribution(windowReports.flatMap(w => w.firstCompleteLatencyMs === null ? [] : [w.firstCompleteLatencyMs])),
      latestCorrection: distribution(windowReports.flatMap(w => w.latestCorrectionLatencyMs === null ? [] : [w.latestCorrectionLatencyMs])) },
    candidateCutoffs, minutes, windows: windowReports,
    limitations: ['Slot completeness is not provider finality.', 'No provider sequence or replay-on-reconnect guarantee.',
      'Receipt cutoff only; fsync completion timestamps are not recorded.', 'No Massive comparison or classifier output.',
      'Clock-jump runs are excluded from latency acceptance; reported values remain forensic diagnostics.'] };
}
