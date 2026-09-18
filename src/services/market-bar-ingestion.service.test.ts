import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { ingestDailyRange, planDailyGaps } from './market-bar-ingestion.service.js';
import { etInstant } from './market-calendar.js';
describe('daily evidence ingestion', () => {
  it('distinguishes closed, not-yet-eligible and missing dates', () => {
    const result = planDailyGaps('2026-09-04', '2026-09-08', new Set(['2026-09-04']), [{ sessionDate: '2026-09-07', type: 'CLOSED', closeTimeMinutesEt: null }], etInstant('2026-09-08', 980));
    expect(result).toEqual({ missing: [], notYetEligible: ['2026-09-08'] });
    expect(planDailyGaps('2026-09-08', '2026-09-08', new Set(), [], etInstant('2026-09-08', 990)).missing).toEqual(['2026-09-08']);
  });
  it('keeps interior operational gaps, not only a maximum timestamp', () => {
    expect(planDailyGaps('2026-09-08', '2026-09-10', new Set(['2026-09-08', '2026-09-10']), [], etInstant('2026-09-11', 600)).missing).toEqual(['2026-09-09']);
  });
  it('inserts only eligible observations using skipDuplicates and no update', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { security: { findUnique: vi.fn().mockResolvedValue({ id: 1 }) }, marketCalendarException: { findMany: vi.fn().mockResolvedValue([]) }, marketBar: { createMany } } as unknown as PrismaClient;
    const fetchBars = vi.fn().mockResolvedValue(['2026-09-14', '2026-09-15'].map(date => ({ barStartAt: etInstant(date, 0), open: '100', high: '102', low: '99', close: '101', volume: '1000', receivedAt: new Date() })));
    expect(await ingestDailyRange('SPY', '2026-09-14', '2026-09-15', { db, fetchBars, now: etInstant('2026-09-15', 980) })).toMatchObject({ eligible: 1, ineligible: 1, inserted: 1 });
    expect(createMany.mock.calls[0]?.[0]).toMatchObject({ skipDuplicates: true, data: [{ timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED' }] });
  });
  it('uses no Alpaca provider dependency', async () => {
    for (const path of ['src/integrations/massive/evidence.client.ts', 'src/services/market-bar-ingestion.service.ts', 'src/services/market-calendar.ts']) {
      expect(await readFile(path, 'utf8')).not.toMatch(/from\s+['"][^'"]*alpaca/i);
    }
  });
  it('does not request a closed or not-yet-eligible session', async () => {
    const fetchBars=vi.fn();const db={security:{findUnique:vi.fn().mockResolvedValue({id:1})},marketCalendarException:{findMany:vi.fn().mockResolvedValue([{sessionDate:new Date('2026-09-07'),type:'CLOSED',closeTimeMinutesEt:null}])}} as unknown as PrismaClient;
    await ingestDailyRange('SPY','2026-09-07','2026-09-07',{db,fetchBars,now:etInstant('2026-09-07',1000)});
    expect(fetchBars).not.toHaveBeenCalled();
    await ingestDailyRange('SPY','2026-09-08','2026-09-08',{db,fetchBars,now:etInstant('2026-09-08',980)});
    expect(fetchBars).not.toHaveBeenCalled();
  });
  it('a malformed response fails visibly before any insertion',async()=>{
    const insert=vi.fn();const db={security:{findUnique:vi.fn().mockResolvedValue({id:1})},marketCalendarException:{findMany:vi.fn().mockResolvedValue([])},marketBar:{createMany:insert}} as unknown as PrismaClient;
    await expect(ingestDailyRange('SPY','2026-09-08','2026-09-08',{db,now:etInstant('2026-09-08',1000),fetchBars:async()=>{throw new Error('Malformed Massive evidence');}})).rejects.toThrow('Malformed');
    expect(insert).not.toHaveBeenCalled();
  });
});
