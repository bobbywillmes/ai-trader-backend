import { describe, expect, it } from 'vitest';

import {
  isIsolatedManualAcceptanceEnvironment,
  MANUAL_ACCEPTANCE_ENTRYPOINT,
  MANUAL_ACCEPTANCE_SENTINEL,
  MANUAL_ACCEPTANCE_UI_ORIGIN,
} from './manual-acceptance-environment.js';

const valid = {
  sentinel: MANUAL_ACCEPTANCE_SENTINEL,
  entrypoint: MANUAL_ACCEPTANCE_ENTRYPOINT,
  databaseUrl: 'postgresql://trader:test@localhost:5432/ai_trader_live_entry_acceptance',
  allowedOrigins: [MANUAL_ACCEPTANCE_UI_ORIGIN],
};

describe('isolated manual acceptance environment recognition', () => {
  it('does not allow ordinary production localhost CORS', () => {
    expect(isIsolatedManualAcceptanceEnvironment({ ...valid, sentinel: undefined, entrypoint: undefined })).toBe(false);
  });

  it('allows only the exact guarded acceptance environment', () => {
    expect(isIsolatedManualAcceptanceEnvironment(valid)).toBe(true);
  });

  it.each([
    ['wrong database', { databaseUrl: 'postgresql://trader:test@localhost:5432/ai_trader' }],
    ['missing sentinel', { sentinel: undefined }],
    ['wrong sentinel', { sentinel: 'yes-this-is-a-test' }],
    ['missing harness entrypoint', { entrypoint: undefined }],
    ['non-loopback HTTP origin', { allowedOrigins: ['http://acceptance.example:5173'] }],
    ['wildcard origin', { allowedOrigins: ['*'] }],
    ['arbitrary localhost port', { allowedOrigins: ['http://localhost:4173'] }],
    ['additional origin', { allowedOrigins: [MANUAL_ACCEPTANCE_UI_ORIGIN, 'https://admin.example'] }],
  ])('rejects %s', (_label, change) => {
    expect(isIsolatedManualAcceptanceEnvironment({ ...valid, ...change })).toBe(false);
  });
});
