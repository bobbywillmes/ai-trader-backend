export const brokerWriteDeliveryClassifications = [
  'NOT_SENT_RETRYABLE',
  'NOT_SENT_BLOCKED',
  'BROKER_REJECTED',
  'DELIVERY_UNCERTAIN',
] as const;

export type BrokerWriteDeliveryClassification =
  (typeof brokerWriteDeliveryClassifications)[number];

export class BrokerWriteDeliveryError extends Error {
  readonly classification: BrokerWriteDeliveryClassification;
  readonly statusCode: number | null;

  constructor(args: {
    classification: BrokerWriteDeliveryClassification;
    message: string;
    statusCode?: number | null;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = 'BrokerWriteDeliveryError';
    this.classification = args.classification;
    this.statusCode = args.statusCode ?? null;
  }
}

export function getBrokerWriteDeliveryClassification(error: unknown) {
  return error instanceof BrokerWriteDeliveryError
    ? error.classification
    : null;
}
