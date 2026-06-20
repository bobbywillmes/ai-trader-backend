import type { AlpacaRequestMetadata } from '../integrations/alpaca/request-metadata.js';

export class AlpacaRateLimitDeferredError extends Error {
  metadata: AlpacaRequestMetadata;
  backoffUntil: Date | null;

  constructor(args: {
    metadata: AlpacaRequestMetadata;
    backoffUntil: Date | null;
  }) {
    super(
      `Alpaca request deferred during active rate-limit backoff: ${args.metadata.operation}`
    );
    this.name = 'AlpacaRateLimitDeferredError';
    this.metadata = args.metadata;
    this.backoffUntil = args.backoffUntil;
  }
}
