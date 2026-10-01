/** Read-only V6 threshold mirror for provider comparison. No production scorer import. */
export type VolumeMinute = { time: string; volume: number | null; close: number };
type Provider = 'massive' | 'tiingo';
const windows = [5, 15, 30] as const;
const checkpoints = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00'] as const;
const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const round = (n: number | null) => n === null || !Number.isFinite(n) ? null : Number(n.toFixed(8));
const validVolume = (row: VolumeMinute | undefined): row is VolumeMinute & { volume: number } =>
  row !== undefined && typeof row.volume === 'number' && Number.isFinite(row.volume) && row.volume >= 0;
const sum = (rows: VolumeMinute[]) => rows.reduce((total, row) => total + (validVolume(row) ? row.volume : 0), 0);
const ratio = (a: number | null, b: number | null) => round(a !== null && b !== null && b > 0 ? a / b : null);
function etClock(time: string) {
  const parts = clock.formatToParts(new Date(time));
  return `${parts.find(p => p.type === 'hour')?.value}:${parts.find(p => p.type === 'minute')?.value}`;
}
function clockMinutes(value: string) { const [hour, minute] = value.split(':').map(Number); return hour! * 60 + minute!; }
function series(rows: VolumeMinute[]) { return new Map(rows.map(row => [row.time, row])); }
function expectedMinutes(cutoff: string, count: number) {
  const end = Date.parse(cutoff);
  return Array.from({ length: count }, (_, index) => new Date(end - (count - 1 - index) * 60_000).toISOString());
}
function regularMinutesThrough(cutoff: string): string[] | null {
  const offset = clockMinutes(etClock(cutoff)) - 570;
  if (offset < 0 || offset >= 390) return null;
  return expectedMinutes(cutoff, offset + 1);
}
function regularSessionVolumeParity(maps: Record<Provider, Map<string, VolumeMinute>>, cutoff: string | null) {
  const providers: Provider[] = ['massive', 'tiingo'];
  const sourceCommonCutoff = cutoff;
  const sourceClock = cutoff ? clockMinutes(etClock(cutoff)) : null;
  const cutoffAdjustment = sourceClock !== null && sourceClock >= 960 ? 'CLAMPED_TO_REGULAR_SESSION_END' : 'NONE';
  const effectiveRegularCutoff = cutoff === null || sourceClock === null || sourceClock < 570 ? null
    : sourceClock < 960 ? cutoff : new Date(Date.parse(cutoff) - (sourceClock - 959) * 60_000).toISOString();
  const expected = effectiveRegularCutoff ? regularMinutesThrough(effectiveRegularCutoff) : null;
  const cumulative = Object.fromEntries(providers.map(provider => {
    const observed = expected?.filter(time => validVolume(maps[provider].get(time))).length ?? 0;
    const complete = expected !== null && observed === expected.length;
    return [provider, { expectedMinuteCount: expected?.length ?? 0, observedMinuteCount: observed,
      complete, cumulativeVolumeThroughCutoff: complete ? sum(expected!.map(time => maps[provider].get(time)!)) : null }];
  })) as Record<Provider, { expectedMinuteCount: number; observedMinuteCount: number; complete: boolean; cumulativeVolumeThroughCutoff: number | null }>;
  const recentWindows = Object.fromEntries(windows.map(count => {
    const slots = expected?.slice(-count) ?? [];
    const windowFits = slots.length === count;
    const values = Object.fromEntries(providers.map(provider => {
      const observed = slots.filter(time => validVolume(maps[provider].get(time))).length;
      const complete = windowFits && observed === count;
      const recentVolume = complete ? sum(slots.map(time => maps[provider].get(time)!)) : null;
      const denominator = cumulative[provider].cumulativeVolumeThroughCutoff;
      const intensity = complete && denominator !== null && denominator > 0 ? recentVolume! / denominator : null;
      return [provider, { observedMinuteCount: observed, recentVolume, cumulativeVolumeThroughCutoff: denominator,
        volumeIntensity: intensity, ...v6IntensityBucket(intensity),
        availability: expected === null ? cutoff ? 'CUTOFF_BEFORE_REGULAR_OPEN' : 'NO_COMMON_CUTOFF'
          : !cumulative[provider].complete ? 'INCOMPLETE_REGULAR_CUMULATIVE' : !windowFits ? 'WINDOW_CROSSES_OPEN'
          : !complete ? 'INCOMPLETE_RECENT_WINDOW' : denominator === 0 ? 'ZERO_CUMULATIVE_VOLUME' : 'COMPLETE' }];
    })) as Record<Provider, { observedMinuteCount: number; recentVolume: number | null; cumulativeVolumeThroughCutoff: number | null;
      volumeIntensity: number | null; bucket: string; points: number | null; availability: string }>;
    return [String(count), { expectedMinuteCount: count, massive: values.massive, tiingo: values.tiingo,
      sharedMinuteCount: slots.filter(time => providers.every(provider => validVolume(maps[provider].get(time)))).length }];
  })) as Record<'5' | '15' | '30', { expectedMinuteCount: number; sharedMinuteCount: number;
    massive: { observedMinuteCount: number; recentVolume: number | null; cumulativeVolumeThroughCutoff: number | null;
      volumeIntensity: number | null; bucket: string; points: number | null; availability: string };
    tiingo: { observedMinuteCount: number; recentVolume: number | null; cumulativeVolumeThroughCutoff: number | null;
      volumeIntensity: number | null; bucket: string; points: number | null; availability: string } }>;
  const primary = recentWindows['30'];
  const comparable = primary.massive.volumeIntensity !== null && primary.tiingo.volumeIntensity !== null;
  const reached = effectiveRegularCutoff ? etClock(effectiveRegularCutoff) : null;
  const checkpointLabels = [...checkpoints.filter(label => reached !== null && reached >= label),
    ...(effectiveRegularCutoff ? ['EFFECTIVE_REGULAR_CUTOFF'] : [])];
  const cumulativeCheckpoints = checkpointLabels.map(label => {
    const point = !effectiveRegularCutoff ? null : label === 'EFFECTIVE_REGULAR_CUTOFF' ? effectiveRegularCutoff
      : new Date(Date.parse(effectiveRegularCutoff) - (clockMinutes(reached!) - clockMinutes(label)) * 60_000).toISOString();
    const slots = point ? regularMinutesThrough(point) : null;
    const observed = Object.fromEntries(providers.map(provider => [provider, slots?.filter(time => validVolume(maps[provider].get(time))).length ?? 0])) as Record<Provider, number>;
    const complete = slots !== null && providers.every(provider => observed[provider] === slots.length);
    const m = complete ? sum(slots!.map(time => maps.massive.get(time)!)) : null;
    const t = complete ? sum(slots!.map(time => maps.tiingo.get(time)!)) : null;
    return { checkpoint: label, checkpointAt: point, expectedMinuteCount: slots?.length ?? 0,
      massiveObservedMinuteCount: observed.massive, tiingoObservedMinuteCount: observed.tiingo,
      massiveCumulativeVolume: m, tiingoCumulativeVolume: t, tiingoToMassiveRatio: ratio(t, m),
      availability: complete ? 'COMPLETE' : 'INCOMPLETE_REGULAR_EVIDENCE' };
  });
  return { researchOnly: true, session: 'NEW_YORK_REGULAR_09_30_TO_16_00', cutoff,
    sourceCommonCutoff, effectiveRegularCutoff, cutoffAdjustment,
    availability: expected === null ? cutoff ? 'CUTOFF_BEFORE_REGULAR_OPEN' : 'NO_COMMON_CUTOFF' : 'EVALUATED',
    cumulative, windows: recentWindows,
    thirtyMinuteParity: { massiveBucket: primary.massive.bucket, tiingoBucket: primary.tiingo.bucket,
      sameBucket: comparable ? primary.massive.bucket === primary.tiingo.bucket : null,
      massiveIntensityPoints: primary.massive.points, tiingoIntensityPoints: primary.tiingo.points,
      sameIntensityPoints: comparable ? primary.massive.points === primary.tiingo.points : null },
    cumulativeCheckpoints };
}
export function v6IntensityBucket(value: number | null) {
  if (value === null) return { bucket: 'UNAVAILABLE', points: null } as const;
  if (value >= .10) return { bucket: 'STRONG', points: 20 } as const;
  if (value >= .03) return { bucket: 'MODERATE', points: 10 } as const;
  return { bucket: 'LOW', points: 0 } as const;
}
export function v6LiquidityBucket(value: number | null, minimumDollarVolume: number) {
  if (value === null) return 'UNAVAILABLE' as const;
  if (value < minimumDollarVolume * .2) return 'INSUFFICIENT_DOLLAR_LIQUIDITY' as const;
  if (value < minimumDollarVolume * .5) return 'BELOW_HALF_MINIMUM' as const;
  if (value < minimumDollarVolume) return 'MODERATE_DOLLAR_LIQUIDITY' as const;
  return 'MINIMUM_MET' as const;
}

/** All volumes use each provider's own minute evidence. Both-missing minutes remain unknowable. */
export function compareVolumeIntensity(args: { massive: VolumeMinute[]; tiingo: VolumeMinute[];
  cutoff: string | null; minimumDollarVolume: number; configuredRecentWindowMinutes: number }) {
  const { cutoff, minimumDollarVolume, configuredRecentWindowMinutes } = args;
  if (!Number.isFinite(minimumDollarVolume) || minimumDollarVolume <= 0) throw new Error('Invalid minimum dollar volume');
  const maps = { massive: series(args.massive), tiingo: series(args.tiingo) };
  const providers: Provider[] = ['massive', 'tiingo'];
  const eligible = (provider: Provider, end: string) => [...maps[provider].values()].filter(row => row.time <= end).sort((a, b) => a.time.localeCompare(b.time));
  const union = cutoff ? [...new Set([...maps.massive.keys(), ...maps.tiingo.keys()].filter(time => time <= cutoff))].sort() : [];
  const cumulativeProviderComplete = Object.fromEntries(providers.map(provider => [provider,
    cutoff !== null && union.length > 0 && union.every(time => validVolume(maps[provider].get(time)))])) as Record<Provider, boolean>;
  const cumulativeComplete = providers.every(provider => cumulativeProviderComplete[provider]);
  const observedCumulative = Object.fromEntries(providers.map(provider => [provider, cutoff ? sum(eligible(provider, cutoff)) : null])) as Record<Provider, number | null>;
  const cumulative = Object.fromEntries(providers.map(provider => [provider,
    cumulativeProviderComplete[provider] ? observedCumulative[provider] : null])) as Record<Provider, number | null>;
  const recentWindows = Object.fromEntries(windows.map(count => {
    const expected = cutoff ? expectedMinutes(cutoff, count) : [];
    const observed = Object.fromEntries(providers.map(provider => [provider, expected.filter(time => validVolume(maps[provider].get(time))).length])) as Record<Provider, number>;
    const shared = expected.filter(time => providers.every(provider => validVolume(maps[provider].get(time)))).length;
    const result = Object.fromEntries(providers.map(provider => {
      const complete = expected.length === count && observed[provider] === count && cumulativeComplete && (cumulative[provider] ?? 0) > 0;
      const observedRecentVolume = expected.length ? sum(expected.flatMap(time => { const row = maps[provider].get(time); return row ? [row] : []; })) : null;
      const recentVolume = observed[provider] === count ? observedRecentVolume : null;
      return [provider, { recentVolume, observedRecentVolume, cumulativeVolumeThroughCutoff: cumulative[provider],
        volumeIntensity: complete && recentVolume !== null ? recentVolume / cumulative[provider]! : null,
        available: complete, availability: !cutoff ? 'NO_COMMON_CUTOFF' : observed[provider] !== count ? 'INCOMPLETE_RECENT_WINDOW'
          : !cumulativeComplete ? 'INCOMPLETE_CUMULATIVE_COVERAGE' : (cumulative[provider] ?? 0) <= 0 ? 'ZERO_CUMULATIVE_VOLUME' : 'COMPLETE' }];
    })) as unknown as Record<Provider, { recentVolume: number | null; observedRecentVolume: number | null;
      cumulativeVolumeThroughCutoff: number | null; volumeIntensity: number | null; available: boolean; availability: string }>;
    return [String(count), { minutes: count, expectedMinuteCount: count,
      massiveObservedMinuteCount: observed.massive, tiingoObservedMinuteCount: observed.tiingo,
      sharedMinuteCount: shared, completeness: { massive: observed.massive === count, tiingo: observed.tiingo === count,
        cumulativeProviderParity: cumulativeComplete }, massive: result.massive, tiingo: result.tiingo }];
  })) as Record<'5' | '15' | '30', { minutes: number; expectedMinuteCount: number; massiveObservedMinuteCount: number;
    tiingoObservedMinuteCount: number; sharedMinuteCount: number; completeness: { massive: boolean; tiingo: boolean; cumulativeProviderParity: boolean };
    massive: { recentVolume: number | null; observedRecentVolume: number | null; cumulativeVolumeThroughCutoff: number | null; volumeIntensity: number | null; available: boolean; availability: string };
    tiingo: { recentVolume: number | null; observedRecentVolume: number | null; cumulativeVolumeThroughCutoff: number | null; volumeIntensity: number | null; available: boolean; availability: string } }>;
  const primary = recentWindows['30'];
  const massiveBucket = v6IntensityBucket(primary.massive.volumeIntensity);
  const tiingoBucket = v6IntensityBucket(primary.tiingo.volumeIntensity);
  const intensityAvailable = primary.massive.volumeIntensity !== null && primary.tiingo.volumeIntensity !== null;
  const intensityDifference = intensityAvailable ? Math.abs(primary.massive.volumeIntensity! - primary.tiingo.volumeIntensity!) : null;
  const reference = Object.fromEntries(providers.map(provider => [provider, cutoff ? maps[provider].get(cutoff)?.close ?? null : null])) as Record<Provider, number | null>;
  const dollar = Object.fromEntries(providers.map(provider => [provider, cumulativeComplete && reference[provider] !== null && cumulative[provider] !== null
    ? round(reference[provider]! * cumulative[provider]!) : null])) as Record<Provider, number | null>;
  const liquidity = { massiveEstimatedDollarVolume: dollar.massive, tiingoEstimatedDollarVolume: dollar.tiingo,
    referencePriceSource: 'COMMON_CUTOFF_MINUTE_CLOSE', massiveReferencePrice: reference.massive, tiingoReferencePrice: reference.tiingo,
    minimumDollarVolume, massiveLiquidityBucket: v6LiquidityBucket(dollar.massive, minimumDollarVolume),
    tiingoLiquidityBucket: v6LiquidityBucket(dollar.tiingo, minimumDollarVolume),
    sameLiquidityDecision: dollar.massive !== null && dollar.tiingo !== null
      ? v6LiquidityBucket(dollar.massive, minimumDollarVolume) === v6LiquidityBucket(dollar.tiingo, minimumDollarVolume) : null };
  const reached = cutoff ? etClock(cutoff) : null;
  const atCheckpoint = (label: string, end: string) => {
    const times = union.filter(time => time <= end);
    const complete = times.length > 0 && times.every(time => providers.every(provider => validVolume(maps[provider].get(time))));
    const m = sum(eligible('massive', end)); const t = sum(eligible('tiingo', end));
    return { checkpoint: label, massiveCumulativeVolume: complete ? m : null, tiingoCumulativeVolume: complete ? t : null,
      observedMassiveVolume: m, observedTiingoVolume: t,
      tiingoToMassiveRatio: complete ? ratio(t, m) : null, coverage: complete ? 'COMPLETE_ON_OBSERVED_UNION' : 'PROVIDER_MINUTE_MISMATCH' };
  };
  const checkpointsReached = checkpoints.filter(label => reached !== null && reached >= label).map(label => {
    const end = union.filter(time => etClock(time) <= label).at(-1);
    return end ? atCheckpoint(label, end) : { checkpoint: label, massiveCumulativeVolume: null, tiingoCumulativeVolume: null,
      tiingoToMassiveRatio: null, coverage: 'NO_MINUTE_EVIDENCE' };
  });
  if (cutoff) checkpointsReached.push(atCheckpoint('COMMON_CUTOFF', cutoff));
  const observedExtended = Object.fromEntries(providers.map(provider => {
    const recent = primary[provider].observedRecentVolume;
    const denominator = observedCumulative[provider];
    const intensity = recent !== null && denominator !== null && denominator > 0 ? recent / denominator : null;
    return [provider, { observedRecentVolume: recent, observedCumulativeVolume: denominator,
      observedVolumeIntensity: intensity, ...v6IntensityBucket(intensity),
      observedMinuteCount: provider === 'massive' ? primary.massiveObservedMinuteCount : primary.tiingoObservedMinuteCount }];
  })) as Record<Provider, { observedRecentVolume: number | null; observedCumulativeVolume: number | null;
    observedVolumeIntensity: number | null; bucket: string; points: number | null; observedMinuteCount: number }>;
  return { cutoff, cumulativeStart: union[0] ?? null, cumulativeCoverage: !cutoff ? 'NO_COMMON_CUTOFF'
    : cumulativeComplete ? 'COMPLETE_ON_OBSERVED_UNION' : 'PROVIDER_MINUTE_MISMATCH',
    massiveDayVolumeThroughCutoff: cumulative.massive, tiingoDayVolumeThroughCutoff: cumulative.tiingo,
    cumulativeVolumeThroughCutoff: cumulative, observedCumulativeVolume: observedCumulative,
    configuredRecentWindowMinutes, primaryWindowMinutes: 30,
    primaryMatchesConfiguredWindow: configuredRecentWindowMinutes === 30, windows: recentWindows,
    v6ThirtyMinuteParity: { massiveBucket: massiveBucket.bucket, tiingoBucket: tiingoBucket.bucket,
      sameBucket: intensityAvailable ? massiveBucket.bucket === tiingoBucket.bucket : null,
      massiveIntensityPoints: massiveBucket.points, tiingoIntensityPoints: tiingoBucket.points,
      sameIntensityPoints: intensityAvailable ? massiveBucket.points === tiingoBucket.points : null,
      absoluteIntensityDifference: round(intensityDifference), relativeIntensityDifference: intensityAvailable
        ? ratio(intensityDifference, primary.massive.volumeIntensity) : null },
    liquidity, cumulativeCheckpoints: checkpointsReached,
    regularSessionVolumeParity: regularSessionVolumeParity(maps, cutoff),
    OBSERVED_EXTENDED_DIAGNOSTIC: { researchOnly: true, authoritativeParity: false, windowMinutes: 30,
      massive: observedExtended.massive, tiingo: observedExtended.tiingo,
      sameBucket: observedExtended.massive.bucket !== 'UNAVAILABLE' && observedExtended.tiingo.bucket !== 'UNAVAILABLE'
        ? observedExtended.massive.bucket === observedExtended.tiingo.bucket : null } };
}
