import { describe, expect, it } from 'vitest';
import { subscriptionEntryPreviewSchema } from './trading-lifecycle-exercise.schema.js';

const valid = {
  reason: 'Paper canary', subscriptionId: 7,
  tradingAccountSubscriptionIds: [1], environment: 'PAPER',
};

describe('explicit assignment Lifecycle Exercise preview schema', () => {
  it('accepts one or more unique assignment IDs', () => {
    expect(subscriptionEntryPreviewSchema.parse(valid).tradingAccountSubscriptionIds).toEqual([1]);
    expect(subscriptionEntryPreviewSchema.parse({ ...valid, tradingAccountSubscriptionIds: [1, 2] }).tradingAccountSubscriptionIds).toEqual([1, 2]);
  });

  it.each([
    { ids: [], expected: 'EMPTY_ASSIGNMENT_SELECTION' },
    { ids: Array.from({ length: 26 }, (_, index) => index + 1), expected: 'ASSIGNMENT_TARGET_LIMIT_EXCEEDED' },
    { ids: [1, 1], expected: 'DUPLICATE_ASSIGNMENT_ID' },
  ])('rejects invalid target sets ($expected)', ({ ids, expected }) => {
    const result = subscriptionEntryPreviewSchema.safeParse({ ...valid, tradingAccountSubscriptionIds: ids });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? {} : result.error.issues)).toContain(expected);
  });

  it('retains the PAPER-only boundary', () => {
    expect(subscriptionEntryPreviewSchema.safeParse({ ...valid, environment: 'LIVE' }).success).toBe(false);
  });
});
