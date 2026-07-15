import type {
  MomentumMarketChartInterval,
  MomentumResearchCandidateDetail,
} from "./types";

type Candidate = MomentumResearchCandidateDetail["candidate"];

const intervalRangeMs: Record<MomentumMarketChartInterval, number> = {
  "1m": 24 * 60 * 60 * 1000,
  "5m": 7 * 24 * 60 * 60 * 1000,
  "15m": 14 * 24 * 60 * 60 * 1000,
  "1d": 183 * 24 * 60 * 60 * 1000,
};

function lifecycleTimes(candidate: Candidate) {
  const values = [
    candidate.catalystEvent?.publishedAt,
    candidate.catalystEvent?.receivedAt,
    candidate.discoveredAt,
    candidate.lastEvaluatedAt,
    ...candidate.priceChecks.map((check) => check.observedAt),
    ...candidate.scannerHandoffs.flatMap((handoff) => [
      handoff.preparedAt, handoff.sentAt, handoff.acknowledgedAt,
      handoff.failedAt, handoff.updatedAt,
    ]),
  ].flatMap((value) => {
    if (!value) return [];
    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) ? [] : [timestamp];
  });

  return values.length ? values : [new Date(candidate.discoveredAt).getTime()];
}

export function recommendedMarketChartInterval(candidate: Candidate) {
  const times = lifecycleTimes(candidate);
  const spanWithContext = Math.max(...times) - Math.min(...times) + 2 * 60 * 60 * 1000;
  return (["1m", "5m", "15m", "1d"] as MomentumMarketChartInterval[])
    .find((interval) => spanWithContext <= intervalRangeMs[interval]) ?? "1d";
}

export function momentumCandidateChartRange(
  candidate: Candidate,
  interval: MomentumMarketChartInterval
) {
  const times = lifecycleTimes(candidate);
  const desiredFrom = Math.min(...times) - 60 * 60 * 1000;
  const desiredTo = Math.max(...times) + 60 * 60 * 1000;
  const maximum = intervalRangeMs[interval];

  if (desiredTo - desiredFrom <= maximum) {
    return { from: new Date(desiredFrom).toISOString(), to: new Date(desiredTo).toISOString() };
  }

  const from = new Date(candidate.discoveredAt).getTime() - 60 * 60 * 1000;
  return { from: new Date(from).toISOString(), to: new Date(from + maximum).toISOString() };
}
