import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertAcceptanceEnvironment } from './guard.js';
import { ACCEPTANCE_SENTINEL } from './constants.js';

const safe = { UI_ACCEPTANCE_SENTINEL: ACCEPTANCE_SENTINEL, NODE_ENV: 'test', PORT: '3304', DATABASE_URL: 'postgresql://ai_trader_ui_acceptance:x@127.0.0.1:55434/ai_trader_ui_acceptance', ALLOW_LIVE_TRADING: 'false', ALLOW_TRADING_ENABLED_ON_START: 'false', LIVE_WRITE_DEPLOYMENT_ROLE: 'OBSERVATION_ONLY', ALPACA_API_KEY: 'ACCEPTANCE_NO_CREDENTIAL', ALPACA_API_SECRET: 'ACCEPTANCE_NO_CREDENTIAL', MASSIVE_API_KEY: 'ACCEPTANCE_NO_CREDENTIAL' } as NodeJS.ProcessEnv;
describe('Phase 3B.4 environment guard', () => {
  it('accepts only the exact disposable identity', () => expect(assertAcceptanceEnvironment(safe).pathname).toBe('/ai_trader_ui_acceptance'));
  it.each([
    ['sentinel', { UI_ACCEPTANCE_SENTINEL: 'wrong' }], ['database', { DATABASE_URL: 'postgresql://ai_trader_ui_acceptance:x@127.0.0.1:55434/ai_trader' }],
    ['user', { DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:55434/ai_trader_ui_acceptance' }], ['host', { DATABASE_URL: 'postgresql://ai_trader_ui_acceptance:x@prod:5432/ai_trader_ui_acceptance' }],
    ['port', { DATABASE_URL: 'postgresql://ai_trader_ui_acceptance:x@127.0.0.1:5433/ai_trader_ui_acceptance' }], ['production', { NODE_ENV: 'production' }],
    ['http port', { PORT: '3000' }], ['credentials', { ALPACA_API_KEY: 'active' }],
  ])('rejects unsafe %s', (_name, change) => expect(() => assertAcceptanceEnvironment({ ...safe, ...change })).toThrow());
});

describe('Phase 3B.4 Compose topology', () => {
  const compose=readFileSync('docker-compose.acceptance.yml','utf8');
  it('publishes only the fixed proxy on loopback',()=>{expect(compose).toContain('"127.0.0.1:3304:8080"');expect(compose.match(/^\s+- "127\.0\.0\.1:/gm)).toHaveLength(1);});
  it('keeps API and database on the internal network only',()=>{expect(compose).toContain('internal: true');expect(compose).toMatch(/api:[\s\S]*?networks: \[acceptance_internal\]/);expect(compose).toMatch(/db:[\s\S]*?networks: \[acceptance_internal\]/);});
});
