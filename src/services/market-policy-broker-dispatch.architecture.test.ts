import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function productionSources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return productionSources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.includes('__tests__') ? [path.replaceAll('\\', '/')] : [];
  });
}

const sources = productionSources(resolve('src')).map((path) => ({ path: path.slice(path.indexOf('src/')), text: readFileSync(path, 'utf8') }));

describe('Phase 3C.3 broker-time market-policy guard architecture', () => {
  it('has exactly one production caller: the entry BUY broker boundary', () => {
    const callers = sources.filter(({ path, text }) => path !== 'src/services/market-policy-broker-dispatch.service.ts' && text.includes('prepareEntryBrokerDispatch('));
    expect(callers.map(({ path }) => path)).toEqual(['src/services/place-order.service.ts']);
  });

  it('runs after the stable client-order-ID lookup and consumes before the entry adapter call', () => {
    const boundary = readFileSync(resolve('src/services/place-order.service.ts'), 'utf8');
    const body = boundary.slice(boundary.indexOf('export async function submitOrderToBroker'));
    const lookup = body.indexOf('getAlpacaOrderByClientOrderId(');
    const prepare = body.indexOf('prepareEntryBrokerDispatch(');
    const consume = body.indexOf('dispatch.authorizeDispatch(');
    const adapter = body.indexOf('submitAlpacaEntryOrder(');
    expect(lookup).toBeGreaterThan(0);
    expect(prepare).toBeGreaterThan(lookup);
    expect(consume).toBeGreaterThan(prepare);
    expect(adapter).toBeGreaterThan(consume);
  });

  it('never gates exits, protective orders, close-position, cancellation or recovery', () => {
    const exitPaths = sources.filter(({ text }) => text.includes('submitVerifiedAlpacaExitOrder') || text.includes('submitVerifiedExit'));
    expect(exitPaths.length).toBeGreaterThan(0);
    for (const { path, text } of exitPaths) {
      expect(text.includes('market-policy-broker-dispatch.service'), path).toBe(false);
    }
  });
});
