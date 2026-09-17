import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Research-only disk cache, gitignored via the existing `node_modules/.cache` convention
 * (see the Volatility research cache). Never used by production workers or the classifier. */
export const DEFAULT_BREADTH_CACHE_DIR = path.join('node_modules', '.cache', 'breadth');

export type CachedResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fileFor(cacheDir: string, kind: 'universe' | 'grouped', date: string): string {
  return path.join(cacheDir, kind, `${date}.json`);
}

export async function readCached<T>(cacheDir: string, kind: 'universe' | 'grouped', date: string): Promise<CachedResult<T> | null> {
  try {
    return JSON.parse(await readFile(fileFor(cacheDir, kind, date), 'utf8')) as CachedResult<T>;
  } catch {
    return null;
  }
}

export async function writeCached<T>(cacheDir: string, kind: 'universe' | 'grouped', date: string, result: CachedResult<T>): Promise<void> {
  const file = fileFor(cacheDir, kind, date);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(result), 'utf8');
}

/** Fetch-through-cache with bounded retry. Permanent-looking provider failures (the
 * transport already fails closed with a descriptive message) are cached as failures so a
 * resumed run does not repeatedly re-request a date outside entitlement or otherwise broken;
 * `refresh: true` ignores and overwrites any existing cache entry for the date. */
export async function cachedFetch<T>(
  cacheDir: string, kind: 'universe' | 'grouped', date: string,
  fetcher: () => Promise<T>,
  options: { refresh?: boolean; retries?: number; retryDelayMs?: number } = {},
): Promise<CachedResult<T> & { fromCache: boolean }> {
  if (!options.refresh) {
    const cached = await readCached<T>(cacheDir, kind, date);
    if (cached) return { ...cached, fromCache: true };
  }
  const retries = options.retries ?? 2;
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const value = await fetcher();
      const result: CachedResult<T> = { ok: true, value };
      await writeCached(cacheDir, kind, date, result);
      return { ...result, fromCache: false };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 500));
    }
  }
  const result: CachedResult<T> = { ok: false, error: lastError };
  await writeCached(cacheDir, kind, date, result);
  return { ...result, fromCache: false };
}

/** Bounded-concurrency map, used to avoid an unbounded provider request fan-out. */
export async function mapWithConcurrency<A, B>(items: readonly A[], concurrency: number, fn: (item: A, index: number) => Promise<B>): Promise<B[]> {
  const results: B[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
