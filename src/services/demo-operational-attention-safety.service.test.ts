import { describe, expect, it } from 'vitest';
import { assertDemoOperationalAttentionSafety } from './demo-operational-attention-safety.service.js';
describe('operational attention demo safety', () => {
  it('accepts only a positive Paper account outside production authority', () => expect(() => assertDemoOperationalAttentionSafety({ nodeEnv: 'development', deploymentRole: 'OBSERVATION_ONLY', accountEnvironment: 'PAPER', accountId: 2 })).not.toThrow());
  it.each([
    { nodeEnv: 'production', deploymentRole: 'OBSERVATION_ONLY', accountEnvironment: 'PAPER', accountId: 2 },
    { nodeEnv: 'development', deploymentRole: 'PRODUCTION_EXECUTOR', accountEnvironment: 'PAPER', accountId: 2 },
    { nodeEnv: 'development', deploymentRole: 'OBSERVATION_ONLY', accountEnvironment: 'LIVE', accountId: 2 },
    { nodeEnv: 'development', deploymentRole: 'OBSERVATION_ONLY', accountEnvironment: 'PAPER', accountId: 0 },
  ])('refuses unsafe context %#', (context) => expect(() => assertDemoOperationalAttentionSafety(context)).toThrow());
});
