import { describe, expect, it } from 'vitest';
import { runTiingoDailyPool } from './tiingo-daily-pool.js';

describe('Tiingo daily symbol pool', () => {
  it.each([8, 3])('processes every symbol with at most %i active jobs', async concurrency => {
    let active = 0; let maximum = 0;
    const releases: Array<() => void> = [];
    const completed: number[] = [];
    const run = runTiingoDailyPool(Array.from({ length: 20 }, (_, i) => i), concurrency, async item => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => { releases.push(resolve); });
      active--;
      completed.push(item);
    });
    expect(maximum).toBe(concurrency);
    while (completed.length < 20) {
      const batch = releases.splice(0);
      batch.forEach(release => release());
      await new Promise(resolve => setImmediate(resolve));
    }
    await run;
    expect(maximum).toBe(concurrency);
    expect(completed.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('lets other jobs finish while one worker waits', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const completed: number[] = [];
    const run = runTiingoDailyPool([0, 1, 2, 3], 2, async item => {
      if (item === 0) await blocked;
      completed.push(item);
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(completed).toEqual([1, 2, 3]);
    release();
    await run;
    expect(completed).toEqual([1, 2, 3, 0]);
  });
});
