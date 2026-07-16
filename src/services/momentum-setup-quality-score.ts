export type MomentumSetupQualityInput = {
  extensionFromVwapPct: number | null;
  distanceFromHighPct: number | null;
  recentMovePct: number | null;
  candidateAgeMinutes: number;
  marketSession: 'PREMARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED';
  newYorkMinuteOfDay: number;
  dollarVolume: number | null;
  minimumDollarVolume: number;
};

export type MomentumSetupQualityResult = {
  score: number;
  reasons: string[];
  hardBlocks: string[];
  inputs: MomentumSetupQualityInput;
};

export function scoreMomentumSetupQuality(input: MomentumSetupQualityInput): MomentumSetupQualityResult {
  let score = 100;
  const reasons: string[] = [];
  const hardBlocks: string[] = [];

  if (
    input.extensionFromVwapPct === null ||
    input.distanceFromHighPct === null ||
    input.recentMovePct === null ||
    input.dollarVolume === null
  ) {
    score -= 25;
    hardBlocks.push('MISSING_SETUP_CONTEXT');
  }
  if (input.extensionFromVwapPct !== null) {
    if (input.extensionFromVwapPct > 8) {
      score -= 40;
      hardBlocks.push('EXCESSIVE_SETUP_EXTENSION');
    } else if (input.extensionFromVwapPct > 6) {
      score -= 30;
      reasons.push('HIGH_VWAP_EXTENSION');
    } else if (input.extensionFromVwapPct > 4) {
      score -= 15;
      reasons.push('ELEVATED_VWAP_EXTENSION');
    } else {
      reasons.push('ORDERLY_VWAP_EXTENSION');
    }
  }
  if (input.distanceFromHighPct !== null) {
    if (input.distanceFromHighPct > 5) {
      score -= 25;
      reasons.push('SHARP_FADE_FROM_HIGH');
    } else if (input.distanceFromHighPct > 3) {
      score -= 10;
      reasons.push('MODERATE_FADE_FROM_HIGH');
    } else {
      reasons.push('HOLDING_NEAR_INTRADAY_HIGH');
    }
  }
  if (Math.abs(input.recentMovePct ?? 0) > 4) {
    score -= 20;
    reasons.push('UNSTABLE_RECENT_MOVE');
  }
  if (input.candidateAgeMinutes > 24 * 60) {
    score -= 30;
    hardBlocks.push('STALE_CANDIDATE_CONTEXT');
  } else if (input.candidateAgeMinutes > 8 * 60) {
    score -= 15;
    reasons.push('AGING_CANDIDATE');
  } else {
    reasons.push('CURRENT_CANDIDATE');
  }
  if (input.marketSession === 'REGULAR' && input.newYorkMinuteOfDay >= 15 * 60 + 30) {
    score -= 10;
    reasons.push('LATE_REGULAR_SESSION');
  }
  if (input.dollarVolume !== null && input.dollarVolume < input.minimumDollarVolume) {
    score -= input.dollarVolume < input.minimumDollarVolume * 0.2 ? 30 : 15;
    reasons.push('BELOW_TARGET_DOLLAR_LIQUIDITY');
  } else if (input.dollarVolume !== null) {
    reasons.push('ADEQUATE_DOLLAR_LIQUIDITY');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    hardBlocks,
    inputs: input,
  };
}
