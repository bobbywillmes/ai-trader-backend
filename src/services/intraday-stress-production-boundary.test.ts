import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Phase 7A production boundary', () => {
  it('keeps the research provider harness out of production', () => {
    for (const file of ['src/services/market-bar-ingestion.service.ts', 'src/services/tiingo-minute-aggregation.ts',
      'src/services/intraday-stress-assessment.service.ts', 'src/integrations/tiingo/rest.client.ts'])
      expect(readFileSync(file, 'utf8')).not.toMatch(/(?:from|import)\s*['"][^'"]*\/dev\//);
  });
});
