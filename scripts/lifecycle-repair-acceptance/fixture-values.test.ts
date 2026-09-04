import { describe, expect, it } from 'vitest';

import { HISTORICAL_ORDER_MINIMUM_AGE_MS } from '../../src/services/historical-order-lifecycle-diagnostic.service.js';
import { SYNTHETIC_HISTORICAL_FILL_AT } from './fixture-values.js';

describe('lifecycle repair acceptance fixture time', () => {
  it('is older than the historical-order cutoff at runtime', () => {
    expect(SYNTHETIC_HISTORICAL_FILL_AT.getTime()).toBeLessThan(Date.now() - HISTORICAL_ORDER_MINIMUM_AGE_MS);
  });
});
