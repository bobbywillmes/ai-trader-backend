import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const documentation = readFileSync(
  new URL('../../docs/integrations/n8n.md', import.meta.url),
  'utf8'
);

describe('n8n signal entry documentation contracts', () => {
  it('documents the production EntryDecision without account assignment identity', () => {
    const section = documentation
      .split('### Entry Decision Snapshot')[1]
      ?.split('### Production/global entry signal')[0];
    const example = section
      ?.split('Example request:')[1]
      ?.split('Example persisted response:')[0];

    expect(example).toContain('"decisionKey"');
    expect(example).toContain('"subscriptionKey"');
    expect(example).not.toContain('"tradingAccountId"');
    expect(example).not.toContain('"tradingAccountSubscriptionId"');
  });

  it('keeps the targeted assignment entry contract explicit', () => {
    const targeted = documentation.split(
      '### Targeted assignment entry signal'
    )[1];

    expect(targeted).toContain('POST /api/signals/entry/assignment');
    expect(targeted).toContain('"tradingAccountSubscriptionId": 38');
    expect(targeted).toMatch(
      /`subscriptionKey` is not accepted\s+as an alternative routing identity/
    );
  });
});
