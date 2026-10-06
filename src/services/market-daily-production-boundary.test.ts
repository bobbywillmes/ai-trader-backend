import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Phase 8 production authority boundary', () => {
  it('keeps research and Breadth revision dependencies out of the five-sensor panel', () => {
    for (const file of ['src/services/market-daily-authority.ts', 'src/services/market-bar-ingestion.service.ts',
      'src/services/persisted-split-evidence.service.ts', 'src/services/trend-assessment.service.ts',
      'src/services/volatility-assessment.service.ts', 'src/services/participation-assessment.service.ts',
      'src/services/intraday-stress-assessment.service.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/(?:from|import)\s*['"][^'"]*\/dev\//);
    }
    for (const file of ['src/services/market-daily-authority.ts', 'src/services/market-bar-ingestion.service.ts'])
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/BreadthUniverseRevision|breadthUniverseRevision|OrderIntent|StrategyMarketRegimePolicy/);
  });
});
