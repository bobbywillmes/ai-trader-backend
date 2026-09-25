import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, constituentHash, parseUniverseCsv } from './security-universe-import.service.js';

const header = CSV_COLUMNS.join(',');
describe('reviewed Security universe CSV', () => {
  it('uses catalog uppercase symbols without changing punctuation and reads quoted metadata', () => {
    expect(parseUniverseCsv(`\uFEFF${header}\r\nbrk.b,"Berkshire, Inc.",Financials,Insurance,1,0,0,0,0,0\r\n`)).toEqual([
      { symbol: 'BRK.B', name: 'Berkshire, Inc.', sector: 'Financials', industry: 'Insurance', codes: ['SP500'] },
    ]);
  });
  it.each([
    `${header}\nAAPL,Apple,Tech,Hardware,1,0,0,0,0,0\naapl,Duplicate,Tech,Hardware,0,1,0,0,0,0`,
    `${header}\nAAPL,Apple,Tech,Hardware,0,0,0,0,0,0`,
    `${header}\nAAPL,Apple,Tech,Hardware,yes,0,0,0,0,0`,
    `${header}\nAAPL,Apple,Tech,Hardware,1,0,0,0,0`,
    `${header}\n,,,,,,,,,`,
    `symbol,name,sector,industry,SP500\nAAPL,Apple,Tech,Hardware,1`,
  ])('rejects duplicate or malformed reviewed rows', csv => expect(() => parseUniverseCsv(csv)).toThrow());
  it('hashes the sorted deduplicated constituent identity deterministically', () => {
    expect(constituentHash(['MSFT', 'AAPL'])).toBe(constituentHash(['AAPL', 'MSFT']));
    expect(constituentHash(['AAPL', 'MSFT'])).not.toBe(constituentHash(['AAPL']));
  });
});
