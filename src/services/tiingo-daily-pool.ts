/** Run each symbol job once, with no more than `concurrency` jobs in flight. */
export async function runTiingoDailyPool<T>(work: T[], concurrency: number, process: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < work.length) {
      const item = work[next++]!;
      await process(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, () => worker()));
}
