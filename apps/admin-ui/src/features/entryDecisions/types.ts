export type EntryDecisionSummary = {
  id: number;
  decisionKey: string;
  evaluatedAt: string;
  source: string;
  symbol: string;
  decisionState: string;
  decisionReason: string | null;
  signalAction: string | null;
  signalEligible: boolean | null;
  signalCreated: boolean;
  signalBlocked: boolean;
  blockingReason: string | null;
  persistenceReason: string;
  currentPrice: number | null;
  dipPercent: number | null;
  dipThresholdPercent: number | null;
  allowOrderSignals: boolean | null;
  dryRun: boolean | null;
  eventRisk: string | null;
  marketSession: string | null;
  tradingEnabled: boolean | null;
  killSwitchEnabled: boolean | null;
  paperMode: boolean | null;
  subscriptionId: number | null;
  subscriptionKey: string | null;
  strategyId: number | null;
  strategyKey: string | null;
  exitProfileId: number | null;
  exitProfileKey: string | null;
  orderIntentId: number | null;
  brokerOrderRecordId: number | null;
  trackedPositionId: number | null;
  createdAt: string;
};

export type EntryDecisionFilters = {
  symbol: string | null;
  decisionState: string | null;
  subscriptionId: number | null;
  strategyId: number | null;
  exitProfileId: number | null;
  dateFrom: string | null;
  dateTo: string | null;
  signalCreated: boolean | null;
  signalBlocked: boolean | null;
  limit: number;
};

export type EntryDecisionListResponse = {
  decisions: EntryDecisionSummary[];
  filters: EntryDecisionFilters;
};

export type EntryDecisionQuery = {
  limit?: number;
  symbol?: string;
  decisionState?: string;
  subscriptionId?: number;
  strategyId?: number;
  exitProfileId?: number;
  dateFrom?: string;
  dateTo?: string;
  signalCreated?: boolean;
  signalBlocked?: boolean;
};

export type EntryDecisionRelatedRecord = {
  id: number;
  key?: string | null;
  name?: string | null;
  symbol?: string | null;
  status?: string | null;
  brokerOrderId?: string | null;
  broker?: string | null;
  side?: string | null;
};

export type EntryDecisionDetail = EntryDecisionSummary & {
  previousClose: number | null;
  dayLow: number | null;
  dayChangePercent: number | null;
  retraceFraction: number | null;
  cooldownActive: boolean | null;
  cooldownUntil: string | null;
  minutesSinceLastSignal: number | null;
  decisionFingerprint: string;
  marketSnapshotJson: unknown;
  runtimeSnapshotJson: unknown;
  strategySnapshotJson: unknown;
  indicatorSnapshotJson: unknown;
  rawDecisionJson: unknown;
  updatedAt: string;
  security: EntryDecisionRelatedRecord | null;
  subscription: EntryDecisionRelatedRecord | null;
  strategy: EntryDecisionRelatedRecord | null;
  exitProfile: EntryDecisionRelatedRecord | null;
  orderIntent: EntryDecisionRelatedRecord | null;
  brokerOrderRecord: EntryDecisionRelatedRecord | null;
  trackedPosition: EntryDecisionRelatedRecord | null;
};

export type EntryDecisionDetailResponse = {
  decision: EntryDecisionDetail;
};
