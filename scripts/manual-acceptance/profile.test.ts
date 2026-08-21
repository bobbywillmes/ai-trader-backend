import { afterEach, describe, expect, it } from 'vitest';

import {
  applyManualAcceptanceProfile,
  parseManualAcceptanceFixtureProfile,
  parseManualAcceptanceProfile,
} from './profile.js';

describe('manual acceptance deployment profiles', () => {
  const originalRisk = process.env.ALLOW_LIVE_RISK_REDUCING_WRITES;
  const originalEntry = process.env.ALLOW_LIVE_TRADING;

  afterEach(() => {
    if (originalRisk === undefined) delete process.env.ALLOW_LIVE_RISK_REDUCING_WRITES;
    else process.env.ALLOW_LIVE_RISK_REDUCING_WRITES = originalRisk;
    if (originalEntry === undefined) delete process.env.ALLOW_LIVE_TRADING;
    else process.env.ALLOW_LIVE_TRADING = originalEntry;
  });

  it('uses activation policy with Live entry writes disabled', () => {
    const profile = parseManualAcceptanceProfile('activation');
    expect(applyManualAcceptanceProfile(profile)).toEqual({
      profile: 'activation',
      allowLiveRiskReducingWrites: true,
      allowLiveTrading: false,
    });
    expect(process.env.ALLOW_LIVE_RISK_REDUCING_WRITES).toBe('true');
    expect(process.env.ALLOW_LIVE_TRADING).toBe('false');
  });

  it('uses entry policy only after an explicit entry-profile restart', () => {
    const profile = parseManualAcceptanceProfile('entry');
    expect(applyManualAcceptanceProfile(profile).allowLiveTrading).toBe(true);
    expect(process.env.ALLOW_LIVE_TRADING).toBe('true');
  });

  it.each([undefined, '', 'production', 'both'])('rejects unsupported profile %j', (profile) => {
    expect(() => parseManualAcceptanceProfile(profile)).toThrow(
      'requires an explicit activation or entry profile',
    );
  });

  it('keeps the legacy fixture default and requires an explicit paused fixture', () => {
    expect(parseManualAcceptanceFixtureProfile(undefined)).toBe('entry-ready');
    expect(parseManualAcceptanceFixtureProfile('paused')).toBe('paused');
    expect(() => parseManualAcceptanceFixtureProfile('production')).toThrow(
      'Fixture profile must be entry-ready or paused',
    );
  });
});
