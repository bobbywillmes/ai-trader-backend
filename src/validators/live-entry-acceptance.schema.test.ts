import { describe, expect, it } from 'vitest';

import {
  createLiveEntryAcceptanceRunSchema,
  executeLiveEntryAcceptanceRunSchema,
} from './live-entry-acceptance.schema.js';

describe('Live-entry acceptance request schemas', () => {
  it('does not accept browser-defined order parameters for execution', () => {
    const result = executeLiveEntryAcceptanceRunSchema.safeParse({
      requestKey: 'request-1234',
      expectedPreviewRevision: 2,
      expectedPreviewFingerprint: 'a'.repeat(64),
      typedConfirmation: 'BUY RSP',
      symbol: 'AAPL',
      qty: 100,
    });

    expect(result.success).toBe(false);
  });

  it('accepts only assignment identity and operator reason when creating a run', () => {
    expect(createLiveEntryAcceptanceRunSchema.parse({
      tradingAccountSubscriptionId: 12,
      reason: 'First production canary.',
    })).toEqual({
      tradingAccountSubscriptionId: 12,
      reason: 'First production canary.',
    });
  });
});
