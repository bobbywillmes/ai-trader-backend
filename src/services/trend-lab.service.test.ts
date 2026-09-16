import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, etInstant, isWeekend } from './market-calendar.js';
const mocks = vi.hoisted(()=>({security:vi.fn(),bars:vi.fn(),splits:vi.fn(),calendar:vi.fn(),setting:vi.fn(),publish:vi.fn()}));
vi.mock('../db/prisma.js',()=>({prisma:{security:{findUnique:mocks.security},marketBar:{findMany:mocks.bars},setting:{findUnique:mocks.setting},marketRegimeDimensionAssessment:{create:mocks.publish}}}));
vi.mock('../integrations/massive/evidence.client.js',()=>({fetchSplitEvidence:mocks.splits}));
vi.mock('./market-calendar.service.js',()=>({calendarExceptions:mocks.calendar}));
import { buildLab, clearTrendLabCache, getTrendDay, getTrendLab } from './trend-lab.service.js';
const dates=Array.from({length:730},(_,i)=>addDays('2021-01-01',i)).filter(date=>!isWeekend(date));
const rows=dates.map((date,i)=>({id:i+1,barStartAt:etInstant(date,0),open:100+i*.1,high:101+i*.1,low:99+i*.1,close:100+i*.1,volume:1000}));
beforeEach(()=>{vi.clearAllMocks();clearTrendLabCache();mocks.security.mockResolvedValue({id:1});mocks.bars.mockResolvedValue(rows);mocks.splits.mockResolvedValue([]);mocks.calendar.mockResolvedValue([]);mocks.setting.mockResolvedValue(null);});
describe('read-only Trend Lab research evidence',()=>{
  it('uses the same inputs for all candidates with substantial pre-roll and exact lineage',async()=>{
    const run=await buildLab('2022-01-01','2022-12-30',new Date('2023-01-01T12:00Z'));
    expect(run.series.every(s=>s.source.preRollSessions>=250)).toBe(true);
    expect(run.series[0]?.source.marketBarIds).toEqual(rows.map(r=>r.id));
    expect(Object.keys(run.profiles)).toEqual(['TIGHT','MIDDLE','LOOSE']);
    expect(run.profiles.TIGHT.days.map(x=>x.date)).toEqual(run.profiles.LOOSE.days.map(x=>x.date));
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('changing display start does not restart hysteresis or EMA',async()=>{
    const full=await buildLab('2022-01-01','2022-12-30');const window=await buildLab('2022-09-01','2022-12-30');
    expect(window.profiles.MIDDLE.days).toEqual(full.profiles.MIDDLE.days.filter(d=>d.date>='2022-09-01'));
  });
  it('missing SPY input marks the session unavailable and exposes the incomplete range',async()=>{
    mocks.bars.mockResolvedValueOnce(rows.filter(row=>row!==rows[300])).mockResolvedValueOnce(rows);
    const run=await buildLab('2022-01-01','2022-12-30');
    expect(run.missingDates).toContain(dates[300]);
    expect(run.profiles.MIDDLE.days.find(d=>d.date===dates[300])?.status).toBe('UNAVAILABLE');
  });
  it('fails closed on unavailable split evidence rather than using raw prices',async()=>{
    mocks.splits.mockRejectedValue(new Error('Split authority unavailable'));
    await expect(buildLab('2022-01-01','2022-12-30')).rejects.toThrow('Split authority unavailable');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('serves cached evidence without rebuilding',async()=>{
    const run=await getTrendLab('2022-01-01','2022-12-30');
    const day=await getTrendDay(run.datasetId,'MIDDLE','2022-12-30','2022-01-01','2022-12-30');
    expect(day.spy.measurements).toHaveLength(9);
    expect(day.transition.reason.length).toBeGreaterThan(10);
    expect(mocks.bars).toHaveBeenCalledTimes(2);
  });
  it.each(['expired','cleared'])('recovers an identical %s dataset transparently',async mode=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2023-01-01T12:00Z'));
    const run=await getTrendLab('2022-01-01','2022-12-30');
    if(mode==='cleared')clearTrendLabCache();else vi.setSystemTime(new Date('2023-01-01T12:11Z'));
    const day=await getTrendDay(run.datasetId,'TIGHT','2022-12-30',run.from,run.to);
    expect(day.datasetId).toBe(run.datasetId);expect(day.date).toBe('2022-12-30');
    expect(mocks.bars).toHaveBeenCalledTimes(4);
  });
  it('fails closed when recovered evidence changes',async()=>{
    const run=await getTrendLab('2022-01-01','2022-12-30');clearTrendLabCache();
    mocks.splits.mockResolvedValue([{id:'split',executionDate:'2022-06-01',splitFrom:1,splitTo:2,priceFactor:.5}]);
    await expect(getTrendDay(run.datasetId,'TIGHT','2022-12-30',run.from,run.to)).rejects.toMatchObject({statusCode:409,message:expect.stringContaining('Research evidence changed')});
  });
  it('preserves 404 for unknown dates in verified recovered evidence',async()=>{
    const run=await getTrendLab('2022-01-01','2022-12-30');clearTrendLabCache();
    await expect(getTrendDay(run.datasetId,'TIGHT','2022-01-01',run.from,run.to)).rejects.toMatchObject({statusCode:404});
  });
  it('rejects invalid and mismatched ranges even on cache hits',async()=>{
    const run=await getTrendLab('2022-01-01','2022-12-30');
    for(const [from,to] of [['bad',run.to],[run.to,run.from],['2022-02-30',run.to]]) await expect(getTrendDay(run.datasetId,'TIGHT','2022-12-30',from!,to!)).rejects.toMatchObject({statusCode:400});
    await expect(getTrendDay(run.datasetId,'TIGHT','2022-12-30','2022-02-01',run.to)).rejects.toMatchObject({statusCode:409});
    clearTrendLabCache();
    await expect(getTrendDay(run.datasetId,'TIGHT','2022-12-30','2022-02-01',run.to)).rejects.toMatchObject({statusCode:409});
  });
  it('bounds cache to two ranges and recovers evicted evidence',async()=>{
    const run=await getTrendLab('2022-01-01','2022-12-30');
    await getTrendLab('2022-02-01',run.to);await getTrendLab('2022-03-01',run.to);
    await getTrendDay(run.datasetId,'TIGHT','2022-12-30',run.from,run.to);
    expect(mocks.bars).toHaveBeenCalledTimes(8);
  });
  it('deduplicates recovery and bounds concurrent builds to two ranges',async()=>{
    const run=await getTrendLab('2022-01-01','2022-12-30');clearTrendLabCache();mocks.bars.mockClear();
    let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
    mocks.calendar.mockImplementation(async()=>{await blocked;return [];});
    const first=getTrendDay(run.datasetId,'TIGHT','2022-12-30',run.from,run.to);
    const same=getTrendDay(run.datasetId,'MIDDLE','2022-12-29',run.from,run.to);
    const second=getTrendLab('2022-02-01',run.to);
    await expect(getTrendLab('2022-03-01',run.to)).rejects.toMatchObject({statusCode:429});
    release();await Promise.all([first,same,second]);
    expect(mocks.bars).toHaveBeenCalledTimes(4);
  });
  it('only rebuilds normal loads after expiry or explicit refresh',async()=>{
    const first=await getTrendLab('2022-01-01','2022-12-30');
    await getTrendLab(first.from,first.to);expect(mocks.bars).toHaveBeenCalledTimes(2);
    await getTrendLab(first.from,first.to,true);expect(mocks.bars).toHaveBeenCalledTimes(4);
  });
});
afterEach(()=>vi.useRealTimers());
