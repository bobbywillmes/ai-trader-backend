export type TrendState = 'UP' | 'NEUTRAL' | 'DOWN';
export type TrendProfile = 'TIGHT' | 'MIDDLE' | 'LOOSE';
export type CalendarInput = { sessionDate: string; name: string; type: 'CLOSED' | 'EARLY_CLOSE'; closeTimeMinutesEt: number | null };
export type CalendarException = CalendarInput & { id: number; createdAt: string; updatedAt: string };
export type MarketDataStatus = {
  researchStart: string; dataStart: string; maxBackfillDays: number; operationalFrom: string;
  symbols: { symbol: string; securityId: number | null; count: number; earliest: string | null; latest: string | null; missing: string[]; notYetEligible: string[] }[];
  sync: { fromDate: string; nextAttemptAt: string; lastAttemptAt: string | null; lastResult: string } | null;
  events: { id: number; type: string; message: string; createdAt: string; payloadJson: unknown }[];
};
export type BackfillResult = { results: { symbol: string; from: string; to: string; returned: number; eligible: number; inserted: number; alreadyStored: number; ineligible: number }[] };
export type TrendSummary = { validDays: number; unavailableDays: number; statePercentages: Record<TrendState, number>; transitions: number; transitionsPerYear: Record<string, number>; annualizedTransitions: number; medianRunDuration: number | null; oneDayRuns: number; twoDayOrShorterRuns: number; runDefinition: string };
export type TrendTimeline = { date: string; status: 'VALID' | 'UNAVAILABLE'; rawState: TrendState | null; effectiveState: TrendState | null; transitioned: boolean };
export type TrendBar = { id: number; date: string; open: number; high: number; low: number; close: number; volume: number; normalizationFactor: number; ema10: number | null; ema20: number | null; ema50: number | null };
export type TrendLab = {
  datasetId: string; from: string; to: string; generatedAt: string; evidenceSchemaVersion: number; warnings: string[]; missingDates: string[]; preRollRequired: number;
  profiles: Record<TrendProfile, { summary: TrendSummary; timeline: TrendTimeline[] }>;
  series: { symbol: 'SPY' | 'RSP'; securityId: number; bars: TrendBar[];
    source: { count: number; earliest: string | null; dataThrough: string | null; preRollSessions: number; marketBarIds: number[] };
    splits: { id: string; symbol: string; executionDate: string; splitFrom: number; splitTo: number; priceFactor: number }[] }[];
};
export type InstrumentEvidence = {
  state: TrendState | null; horizons: Record<'SHORT' | 'MEDIUM' | 'STRUCTURAL', TrendState> | null;
  measurements: { key: string; label: string; horizon: string; value: number; deadband: number; classification: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' }[];
  ema10: number | null; ema20: number | null; ema50: number | null; consecutiveSessions: number; reason: string;
};
export type TrendDay = {
  datasetId: string; profile: TrendProfile; date: string; status: 'VALID' | 'UNAVAILABLE'; spy: InstrumentEvidence; rsp: InstrumentEvidence;
  rawState: TrendState | null; effectiveState: TrendState | null; marketReason: string;
  transition: { previousEffectiveState: TrendState | null; rawState: TrendState | null; effectiveState: TrendState | null; confirmationBefore: number; supportingCount: number; recoveryConfirmation: number; nextRecoveryTarget: TrendState | null; transitioned: boolean; reason: string };
};
