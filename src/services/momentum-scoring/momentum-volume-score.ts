export type MomentumVolumeScoreInput = {
  dayVolume: number | null;
  recentVolume: number | null;
  dollarVolume: number | null;
  relativeVolume: number | null;
  minimumDollarVolume: number;
};

export type MomentumVolumeScoreResult = {
  score: number;
  relativeVolume: number | null;
  volumeMetricType: 'VOLUME_INTENSITY_V1';
  volumeIntensity: number | null;
  reasons: string[];
  hardBlocks: string[];
  inputs: MomentumVolumeScoreInput;
};

export function scoreMomentumVolume(input: MomentumVolumeScoreInput): MomentumVolumeScoreResult {
  let score = 0;
  const reasons: string[] = [];
  const hardBlocks: string[] = [];
  const volumeIntensity = input.dayVolume !== null && input.dayVolume > 0 && input.recentVolume !== null
    ? input.recentVolume / input.dayVolume
    : null;

  if (input.dayVolume === null || input.recentVolume === null || input.dollarVolume === null) {
    hardBlocks.push('MISSING_VOLUME_CONTEXT');
  }
  if (input.dollarVolume !== null && input.dollarVolume < input.minimumDollarVolume * 0.2) {
    hardBlocks.push('INSUFFICIENT_DOLLAR_LIQUIDITY');
  }
  if (input.dayVolume !== null && input.dayVolume > 0) {
    score += 15;
    reasons.push('POSITIVE_DAY_VOLUME');
  }
  if (input.dollarVolume !== null) {
    if (input.dollarVolume >= input.minimumDollarVolume) {
      score += 35;
      reasons.push('DOLLAR_VOLUME_THRESHOLD_MET');
    } else if (input.dollarVolume >= input.minimumDollarVolume * 0.5) {
      score += 15;
      reasons.push('MODERATE_DOLLAR_LIQUIDITY');
    }
  }
  if (input.recentVolume !== null && input.recentVolume > 0) {
    score += 20;
    reasons.push('POSITIVE_RECENT_VOLUME');
  }
  if (volumeIntensity !== null) {
    if (volumeIntensity >= 0.1) {
      score += 20;
      reasons.push('STRONG_RECENT_VOLUME_INTENSITY');
    } else if (volumeIntensity >= 0.03) {
      score += 10;
      reasons.push('MODERATE_RECENT_VOLUME_INTENSITY');
    }
  }
  if (input.relativeVolume !== null) {
    if (input.relativeVolume >= 2) {
      score += 10;
      reasons.push('ELEVATED_TRUE_RELATIVE_VOLUME');
    }
  } else {
    reasons.push('TRUE_RELATIVE_VOLUME_UNAVAILABLE');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    relativeVolume: input.relativeVolume,
    volumeMetricType: 'VOLUME_INTENSITY_V1',
    volumeIntensity,
    reasons,
    hardBlocks,
    inputs: input,
  };
}
