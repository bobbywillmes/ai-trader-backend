import { describe, expect, it } from 'vitest';
import router from './dashboard.routes.js';

describe('dashboard market-data routes', () => {
  it('retains Tiingo market state and legacy performance without the retired chart route', () => {
    const paths = router.stack.flatMap(layer => layer.route ? [layer.route.path] : []);
    expect(paths).toContain('/market-state');
    expect(paths).toContain('/index-performance');
    expect(paths).not.toContain('/index-intraday');
  });
});
