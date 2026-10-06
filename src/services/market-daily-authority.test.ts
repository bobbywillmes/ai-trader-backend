import { describe, expect, it, vi } from 'vitest';
import type { MarketBar, Prisma } from '@prisma/client';
vi.mock('../config/env.js', () => ({ env: { MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-09-24', MARKET_DAILY_MASSIVE_RESUME_SESSION: '2026-09-28' } }));
import { canonicalDailySessionDate, dailyAuthoritySegments, dailyProviderProvenance, dailySessionEligible, marketDailyAuthority, readCanonicalDailyBars } from './market-daily-authority.js';
import { etInstant } from './market-calendar.js';

const row = (id: number, date: string, provider: 'MASSIVE' | 'TIINGO', securityId = 1) => ({ id, securityId, timeframe: 'DAY_1',
  barStartAt: provider === 'TIINGO' ? new Date(`${date}T00:00:00Z`) : etInstant(date, 0), provider,
  adjustmentMode: 'UNADJUSTED' }) as MarketBar;
const tx = (rows: MarketBar[], paused = false) => ({ marketBar: { findMany: vi.fn(async () => rows) },
  setting: { findUnique: vi.fn(async () => paused ? { value: 'true' } : null) } }) as unknown as Pick<Prisma.TransactionClient, 'marketBar' | 'setting'>;

describe('shared canonical DAY_1 authority', () => {
  it('uses a strict, independent market-session cutover with Massive unset default', () => {
    expect(marketDailyAuthority('2026-09-23', null, null).provider).toBe('MASSIVE');
    expect(marketDailyAuthority('2026-09-23').provider).toBe('MASSIVE');
    expect(marketDailyAuthority('2026-09-24').provider).toBe('TIINGO');
    expect(marketDailyAuthority('2026-09-25').provider).toBe('TIINGO');
    expect(marketDailyAuthority('2026-09-27').provider).toBe('TIINGO');
    expect(marketDailyAuthority('2026-09-28').provider).toBe('MASSIVE');
    expect(marketDailyAuthority('2026-09-29').provider).toBe('MASSIVE');
    expect(marketDailyAuthority('2026-09-29', '2026-09-24', null).provider).toBe('TIINGO');
    expect(dailyAuthoritySegments('2026-09-23', '2026-09-29')).toEqual([
      { provider: 'MASSIVE', from: '2026-09-23', through: '2026-09-23' },
      { provider: 'TIINGO', from: '2026-09-24', through: '2026-09-27' },
      { provider: 'MASSIVE', from: '2026-09-28', through: '2026-09-29' },
    ]);
    expect(() => marketDailyAuthority('2026-09-24', '2026-02-30', null)).toThrow();
    expect(() => marketDailyAuthority('2026-09-24', '09/24/2026', null)).toThrow();
    expect(() => marketDailyAuthority('2026-09-24', null, '2026-09-28')).toThrow('requires');
    expect(() => marketDailyAuthority('2026-09-24', '2026-09-24', '2026-09-24')).toThrow('later');
    expect(() => marketDailyAuthority('2026-09-24', '2026-09-24', '2026-09-23')).toThrow('later');
    expect(() => marketDailyAuthority('2026-09-24', '2026-09-24', 'bad')).toThrow('Invalid');
  });
  it('normalizes only exact provider-specific midnight timestamps', () => {
    expect(canonicalDailySessionDate(etInstant('2026-09-23', 0), 'MASSIVE')).toBe('2026-09-23');
    expect(canonicalDailySessionDate(new Date('2026-09-24T00:00:00Z'), 'TIINGO')).toBe('2026-09-24');
    expect(() => canonicalDailySessionDate(new Date('2026-09-24T00:00:01Z'), 'TIINGO')).toThrow();
    expect(() => canonicalDailySessionDate(new Date('2026-09-23T00:00:00Z'), 'MASSIVE')).toThrow();
  });
  it('reads one chronological seam and reports bounded truthful provenance', async () => {
    const stored = [row(1, '2026-09-23', 'MASSIVE'), row(2, '2026-09-24', 'TIINGO'), row(3, '2026-09-28', 'MASSIVE')];
    const rows = await readCanonicalDailyBars(tx(stored), [1], '2026-09-23', '2026-09-28');
    expect(rows.map(r => [r.sessionDate, r.provider])).toEqual([['2026-09-23', 'MASSIVE'], ['2026-09-24', 'TIINGO'], ['2026-09-28', 'MASSIVE']]);
    expect(dailyProviderProvenance(rows, '2026-09-23', '2026-09-28')).toMatchObject({ providersPresent: ['MASSIVE', 'TIINGO'], massiveResumeSession: '2026-09-28',
      providerSegments: [{ provider: 'MASSIVE', count: 1 }, { provider: 'TIINGO', count: 1 }, { provider: 'MASSIVE', count: 1 }] });
  });
  it('fails closed on wrong providers before and after cutover, duplicate logical dates, and retention pause', async () => {
    await expect(readCanonicalDailyBars(tx([row(1, '2026-09-23', 'TIINGO')]), [1], '2026-09-23', '2026-09-23')).rejects.toThrow('provider conflict');
    await expect(readCanonicalDailyBars(tx([row(1, '2026-09-24', 'MASSIVE')]), [1], '2026-09-24', '2026-09-24')).rejects.toThrow('provider conflict');
    await expect(readCanonicalDailyBars(tx([row(1, '2026-09-28', 'TIINGO')]), [1], '2026-09-28', '2026-09-28')).rejects.toThrow('provider conflict');
    await expect(readCanonicalDailyBars(tx([row(1, '2026-09-24', 'TIINGO'), row(2, '2026-09-24', 'TIINGO')]), [1], '2026-09-24', '2026-09-24')).rejects.toThrow('Duplicate');
    await expect(readCanonicalDailyBars(tx([], true), [1], '2026-09-23', '2026-09-24')).rejects.toThrow('paused');
  });
  it('uses 20:15 ET Tiingo eligibility and respects closed and early-close sessions', () => {
    const early = [{ sessionDate: '2026-09-24', type: 'EARLY_CLOSE' as const, closeTimeMinutesEt: 780 }];
    expect(dailySessionEligible('2026-09-24', etInstant('2026-09-24', 1214), early)).toBe(false);
    expect(dailySessionEligible('2026-09-24', etInstant('2026-09-24', 1215), early)).toBe(true);
    expect(dailySessionEligible('2026-09-24', etInstant('2026-09-24', 1215), [{ sessionDate: '2026-09-24', type: 'CLOSED', closeTimeMinutesEt: null }])).toBe(false);
    expect(dailySessionEligible('2026-09-26', etInstant('2026-09-26', 1215), [])).toBe(false);
    expect(dailySessionEligible('2026-09-27', etInstant('2026-09-27', 1215), [])).toBe(false);
    expect(dailySessionEligible('2026-09-28', etInstant('2026-09-28', 1215), [{ sessionDate: '2026-09-28', type: 'CLOSED', closeTimeMinutesEt: null }])).toBe(false);
  });
});
