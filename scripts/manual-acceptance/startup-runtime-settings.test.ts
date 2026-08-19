import { describe, expect, it, vi } from 'vitest';

import {
  MANUAL_ACCEPTANCE_ENTRYPOINT,
  MANUAL_ACCEPTANCE_SENTINEL,
  MANUAL_ACCEPTANCE_UI_ORIGIN,
} from '../../src/services/manual-acceptance-environment.js';
import { enforceManualAcceptanceRuntimeSettings } from './startup-runtime-settings.js';

const validEnvironment = {
  sentinel: MANUAL_ACCEPTANCE_SENTINEL,
  entrypoint: MANUAL_ACCEPTANCE_ENTRYPOINT,
  databaseUrl: 'postgresql://trader:test@127.0.0.1:5432/ai_trader_live_entry_acceptance',
  allowedOrigins: [MANUAL_ACCEPTANCE_UI_ORIGIN],
};

function harnessDb() {
  const settings = new Map([
    ['tradingEnabled', 'false'],
    ['killSwitchEnabled', 'true'],
    ['paperMode', 'true'],
    ['unrelatedSetting', 'preserved'],
  ]);
  const ceremonyRecords = {
    approvals: [{ id: 1, revision: 14 }],
    armings: [{ id: 2, oneShotStatus: 'AVAILABLE' }],
    orderIntents: [{ id: 1, status: 'blocked' }],
  };
  const upsert = vi.fn(async ({ where: { key }, update: { value } }) => {
    settings.set(key, value);
  });
  const transaction = vi.fn(async (operation: (tx: { setting: { upsert: typeof upsert } }) => Promise<unknown>) =>
    operation({ setting: { upsert } }));

  return { db: { $transaction: transaction }, settings, ceremonyRecords, upsert, transaction };
}

describe('manual acceptance runtime settings bootstrap', () => {
  it('changes only the two isolated runtime controls and preserves ceremony state', async () => {
    const fixture = harnessDb();
    const ceremonyBefore = structuredClone(fixture.ceremonyRecords);

    await expect(enforceManualAcceptanceRuntimeSettings(fixture.db, validEnvironment)).resolves.toEqual({
      tradingEnabled: 'true',
      killSwitchEnabled: 'false',
    });

    expect(fixture.settings.get('tradingEnabled')).toBe('true');
    expect(fixture.settings.get('killSwitchEnabled')).toBe('false');
    expect(fixture.settings.get('paperMode')).toBe('true');
    expect(fixture.settings.get('unrelatedSetting')).toBe('preserved');
    expect(fixture.ceremonyRecords).toEqual(ceremonyBefore);
    expect(fixture.upsert).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['ordinary production startup', { sentinel: undefined, entrypoint: undefined, databaseUrl: 'postgresql://trader:test@db:5432/ai_trader' }],
    ['wrong database', { databaseUrl: 'postgresql://trader:test@127.0.0.1:5432/ai_trader' }],
    ['missing sentinel', { sentinel: undefined }],
    ['missing internal entrypoint marker', { entrypoint: undefined }],
  ])('fails closed for %s', async (_label, change) => {
    const fixture = harnessDb();

    await expect(enforceManualAcceptanceRuntimeSettings(
      fixture.db,
      { ...validEnvironment, ...change },
    )).rejects.toThrow('exact isolated harness environment');
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.settings.get('tradingEnabled')).toBe('false');
    expect(fixture.settings.get('killSwitchEnabled')).toBe('true');
  });
});
