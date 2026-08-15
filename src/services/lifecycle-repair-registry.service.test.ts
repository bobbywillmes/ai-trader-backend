import { describe, expect, it } from 'vitest';
import { getLifecycleRepairHandlerMetadata } from './lifecycle-repair-registry.service.js';

describe('lifecycle repair registry safety', () => {
  it('registers position attribution as local-only with no broker write methods', () => {
    expect(getLifecycleRepairHandlerMetadata('RESOLVE_POSITION_ATTRIBUTION')).toMatchObject({
      impact: 'LOCAL_ONLY', executableConfidence: ['DETERMINISTIC'],
      brokerReadPolicy: 'ALLOW_EXACT_ORDER_ID_READ', brokerWriteMethods: [],
      applyEnvironments: ['PAPER'],
    });
  });
  it('fails closed for unknown repair types', () => {
    expect(() => getLifecycleRepairHandlerMetadata('ARBITRARY_SQL')).toThrow('Unknown or unsafe');
  });
});
