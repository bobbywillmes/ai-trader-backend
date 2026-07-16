export type MomentumPriceScoreInput = {
  percentFromPreviousClose: number | null;
  aboveVwap: boolean | null;
  distanceFromHighPct: number | null;
  recentMovePct: number | null;
  extensionFromVwapPct: number | null;
  observedAt: Date;
  sourceObservedAt: Date | null;
  marketSession: 'PREMARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED';
  newYorkMinuteOfDay: number;
};

export type MomentumPriceScoreResult = {
  score: number;
  reasons: string[];
  hardBlocks: string[];
  inputs: MomentumPriceScoreInput;
};

const STALE_AFTER_MS = 5 * 60_000;

export function getNewYorkMarketTiming(date: Date): Pick<MomentumPriceScoreInput, 'marketSession' | 'newYorkMinuteOfDay'> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minute = Number(value.hour) * 60 + Number(value.minute);
  const weekday = value.weekday;
  const weekdayOpen = weekday !== 'Sat' && weekday !== 'Sun';
  const marketSession = !weekdayOpen ? 'CLOSED'
    : minute < 9 * 60 + 30 ? 'PREMARKET'
      : minute < 16 * 60 ? 'REGULAR'
        : minute < 20 * 60 ? 'AFTER_HOURS'
          : 'CLOSED';
  return { marketSession, newYorkMinuteOfDay: minute };
}

export function scoreMomentumPriceAction(input: MomentumPriceScoreInput): MomentumPriceScoreResult {
  let score = 0;
  const reasons: string[] = [];
  const hardBlocks: string[] = [];

  if (
    input.percentFromPreviousClose === null ||
    input.aboveVwap === null ||
    input.distanceFromHighPct === null ||
    input.recentMovePct === null ||
    input.extensionFromVwapPct === null
  ) hardBlocks.push('MISSING_PRICE_CONTEXT');

  if (
    input.sourceObservedAt === null ||
    input.observedAt.getTime() - input.sourceObservedAt.getTime() > STALE_AFTER_MS
  ) hardBlocks.push('STALE_PRICE_DATA');

  if (input.aboveVwap === false) hardBlocks.push('BELOW_VWAP');
  if (input.extensionFromVwapPct !== null && input.extensionFromVwapPct > 8) hardBlocks.push('EXCESSIVELY_EXTENDED');
  if (input.distanceFromHighPct !== null && input.distanceFromHighPct > 5) hardBlocks.push('TOO_FAR_FROM_INTRADAY_HIGH');
  if (input.recentMovePct !== null && input.recentMovePct <= -1) hardBlocks.push('NEGATIVE_RECENT_MOMENTUM');

  if (input.percentFromPreviousClose !== null) {
    if (input.percentFromPreviousClose >= 2 && input.percentFromPreviousClose <= 10) {
      score += 20;
      reasons.push('CONFIRMED_POSITIVE_MOVE');
    } else if (input.percentFromPreviousClose > 0 && input.percentFromPreviousClose < 2) {
      score += 10;
      reasons.push('MODEST_POSITIVE_MOVE');
    }
  }
  if (input.aboveVwap === true) {
    score += 25;
    reasons.push('HOLDING_ABOVE_VWAP');
  }
  if (input.distanceFromHighPct !== null) {
    if (input.distanceFromHighPct <= 1.5) {
      score += 25;
      reasons.push('NEAR_INTRADAY_HIGH');
    } else if (input.distanceFromHighPct <= 3) {
      score += 15;
      reasons.push('WITHIN_RANGE_OF_INTRADAY_HIGH');
    }
  }
  if (input.recentMovePct !== null) {
    if (input.recentMovePct >= 0.5 && input.recentMovePct <= 4) {
      score += 20;
      reasons.push('ORDERLY_RECENT_MOMENTUM');
    } else if (input.recentMovePct > 0 && input.recentMovePct < 0.5) {
      score += 10;
      reasons.push('POSITIVE_RECENT_MOMENTUM');
    }
  }
  if (input.extensionFromVwapPct !== null && input.extensionFromVwapPct >= 0) {
    if (input.extensionFromVwapPct <= 4) {
      score += 10;
      reasons.push('ORDERLY_VWAP_EXTENSION');
    } else if (input.extensionFromVwapPct <= 6) {
      score += 5;
      reasons.push('ELEVATED_VWAP_EXTENSION');
    }
  }
  if (input.marketSession === 'REGULAR' && input.newYorkMinuteOfDay >= 15 * 60 + 30) {
    score -= 10;
    reasons.push('LATE_SESSION_PENALTY');
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, hardBlocks, inputs: input };
}
