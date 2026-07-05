import { Prisma } from '@prisma/client';

type PriceCheckLike = {
  dayVolume?: unknown;
  recentVolume?: unknown;
  [key: string]: unknown;
};

function serializeJsonSafeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof Date ||
    value instanceof Prisma.Decimal
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(serializeJsonSafeValue);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      serializeJsonSafeValue(nested),
    ])
  );
}

function serializeVolume(value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function serializeMomentumCandidatePriceCheck<T extends PriceCheckLike | null>(
  priceCheck: T
) {
  if (priceCheck === null) {
    return null;
  }

  return {
    ...priceCheck,
    dayVolume: serializeVolume(priceCheck.dayVolume),
    recentVolume: serializeVolume(priceCheck.recentVolume),
    rawPayload: serializeJsonSafeValue(priceCheck.rawPayload),
    metadata: serializeJsonSafeValue(priceCheck.metadata),
  };
}

export function serializeMomentumPriceConfirmationResponse<T>(response: T): T {
  return serializeJsonSafeValue(response) as T;
}
