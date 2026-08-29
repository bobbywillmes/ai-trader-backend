import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const productionFiles = [
  'src/services/close-position.service.ts',
  'src/services/trailing-stop-exit.service.ts',
  'src/services/place-order.service.ts',
  'src/workers/order.worker.ts',
];

describe('production equity sell architecture', () => {
  it('routes every real exit producer through the verified boundary', () => {
    for (const file of productionFiles.slice(0, 2)) {
      expect(readFileSync(resolve(file), 'utf8'), file).toContain('submitVerifiedExit');
    }
  });

  it('keeps the raw verified Alpaca SELL adapter private to the verifier', () => {
    const consumers = productionFiles.filter((file) =>
      readFileSync(resolve(file), 'utf8').includes('submitVerifiedAlpacaExitOrder')
    );
    expect(consumers).toEqual([]);
    expect(readFileSync(resolve('src/services/verified-exit-submission.service.ts'), 'utf8')).toContain(
      'submitVerifiedAlpacaExitOrder'
    );
  });

  it('makes the entry broker boundary BUY-only and prohibits sell_to_open', () => {
    const adapter = readFileSync(resolve('src/integrations/alpaca/orders.adapter.ts'), 'utf8');
    expect(adapter).toContain("side: 'buy'");
    expect(adapter).toContain("position_intent: 'sell_to_close'");
    expect(adapter).not.toContain('sell_to_open');
  });
});
