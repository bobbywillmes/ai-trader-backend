import { serializeMomentumCandidatePriceCheck } from './momentum-candidate-price-check.serializer.js';

type HandoffLike = {
  momentumCandidate?: {
    priceChecks?: unknown[];
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

/**
 * Prisma represents MomentumCandidatePriceCheck volume columns as bigint.
 * The momentum handoff API contract represents those unbounded values as strings.
 */
export function serializeMomentumScannerHandoff<T extends HandoffLike>(handoff: T) {
  const candidate = handoff.momentumCandidate;

  if (!candidate?.priceChecks) {
    return handoff;
  }

  return {
    ...handoff,
    momentumCandidate: {
      ...candidate,
      priceChecks: candidate.priceChecks.map((priceCheck) =>
        serializeMomentumCandidatePriceCheck(
          priceCheck as Parameters<typeof serializeMomentumCandidatePriceCheck>[0]
        )
      ),
    },
  };
}

export function serializeMomentumScannerHandoffs<T extends HandoffLike>(handoffs: T[]) {
  return handoffs.map(serializeMomentumScannerHandoff);
}

export function serializeMomentumScannerHandoffPreparation<
  T extends { handoffs: HandoffLike[] },
>(result: T) {
  return {
    ...result,
    handoffs: serializeMomentumScannerHandoffs(result.handoffs),
  };
}
