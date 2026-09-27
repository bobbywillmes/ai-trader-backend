import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, constituentHash, parseUniverseCsv } from './security-universe-import.service.js';

const header = CSV_COLUMNS.join(',');
describe('reviewed Security universe CSV', () => {
  it('uses catalog uppercase symbols without changing punctuation and reads quoted metadata', () => {
    expect(parseUniverseCsv(`\uFEFF${header}\r\nbrk.b,"Berkshire, Inc.",Financials,Insurance,1,0,0,0,0,0\r\n`).rows).toEqual([
      { symbol: 'BRK.B', name: 'Berkshire, Inc.', sector: 'Financials', industry: 'Insurance', flags: { SP500: '1', NASDAQ100: '0', DJIA: '0', RUSSELL2000: '0', SP400: '0', SP600: '0' } },
    ]);
  });
  it.each([
    `${header}\nAAPL,Apple,Tech,Hardware,1,0,0,0,0,0\naapl,Duplicate,Tech,Hardware,0,1,0,0,0,0`,
    `${header}\nAAPL,Apple,Tech,Hardware,yes,0,0,0,0,0`,
    `${header}\nAAPL,Apple,Tech,Hardware,1,0,0,0,0`,
    `${header}\n,,,,,,,,,`,
    `symbol,enabled\nAAPL,true`,
    `symbol,symbol\nAAPL,AAPL`,
  ])('rejects duplicate or malformed reviewed rows', csv => expect(() => parseUniverseCsv(csv)).toThrow());
  it('supports sparse arbitrary ordering, blank partial values and explicit snapshot cells', () => {
    expect(parseUniverseCsv('SP600,symbol,name\n1,brk.b,\n').rows).toEqual([{ symbol: 'BRK.B', flags: { SP600: '1' } }]);
    expect(parseUniverseCsv('symbol\nAAPL\n').rows).toEqual([{ symbol: 'AAPL', flags: {} }]);
    expect(() => parseUniverseCsv('symbol,SP600\nAAPL,\n', 'snapshot')).toThrow();
  });
  it('hashes the sorted deduplicated constituent identity deterministically', () => {
    expect(constituentHash(['MSFT', 'AAPL'])).toBe(constituentHash(['AAPL', 'MSFT']));
    expect(constituentHash(['AAPL', 'MSFT'])).not.toBe(constituentHash(['AAPL']));
  });
});
