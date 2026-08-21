export const manualAcceptanceProfiles = ['activation', 'entry'] as const;

export type ManualAcceptanceProfile = (typeof manualAcceptanceProfiles)[number];
export type ManualAcceptanceFixtureProfile = 'entry-ready' | 'paused';

export function parseManualAcceptanceProfile(value: string | undefined) {
  if (value === 'activation' || value === 'entry') return value;
  throw new Error(
    'Manual acceptance server requires an explicit activation or entry profile.',
  );
}

export function applyManualAcceptanceProfile(profile: ManualAcceptanceProfile) {
  process.env.ALLOW_LIVE_RISK_REDUCING_WRITES = 'true';
  process.env.ALLOW_LIVE_TRADING = profile === 'entry' ? 'true' : 'false';
  return {
    profile,
    allowLiveRiskReducingWrites: true,
    allowLiveTrading: profile === 'entry',
  };
}

export function parseManualAcceptanceFixtureProfile(value: string | undefined) {
  const profile = value ?? 'entry-ready';
  if (profile === 'entry-ready' || profile === 'paused') return profile;
  throw new Error('Fixture profile must be entry-ready or paused.');
}
