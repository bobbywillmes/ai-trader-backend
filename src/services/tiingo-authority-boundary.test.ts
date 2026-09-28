import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Phase 4 provider authority boundary', () => {
  it('keeps Tiingo ingestion out of Massive publishers and trading consumers', () => {
    const files = [
      'src/services/trend-assessment.service.ts',
      'src/services/volatility-assessment.service.ts',
      'src/services/intraday-stress-assessment.service.ts',
      'src/services/participation-assessment.service.ts',
      'src/services/momentum-pipeline-run.service.ts',
      'src/services/place-order.service.ts',
      'src/services/risk-gate.service.ts',
      'src/services/market-bar-ingestion.service.ts',
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from ['"].*tiingo(?:\/|\-daily)/i);
    }
  });
});
