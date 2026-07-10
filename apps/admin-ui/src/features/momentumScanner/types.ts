export type JsonRecord = Record<string, unknown>;

export type CatalystEventQuery = {
  limit?: number;
  symbol?: string;
  source?: string;
  eventType?: string;
  eventTier?: string;
};

export type MomentumCandidateQuery = {
  limit?: number;
  symbol?: string;
  state?: MomentumCandidateState;
};

export type MomentumScannerHandoffQuery = {
  limit?: number;
  symbol?: string;
  status?: MomentumScannerHandoffStatus;
  candidateId?: string;
};

export type GenerateMomentumCandidatesRequest = {
  minCatalystScore?: number;
  take?: number;
  expiresInHours?: number;
  recentSince?: string;
};

export type ConfirmMomentumPricesRequest = {
  maxCandidates?: number;
  minCatalystScore?: number;
  state?: MomentumCandidateState;
  recentWindowMinutes?: number;
  lookbackMinutes?: number;
  now?: string;
};

export type PrepareMomentumScannerHandoffsRequest = {
  candidateId?: string;
  maxCandidates?: number;
  minScore?: number;
  force?: boolean;
  payloadVersion?: string;
  now?: string;
};

export type CatalystEvent = {
  id: string;
  source: string;
  sourceExternalId: string | null;
  sourcePublisher: string | null;
  sourceUrl: string | null;
  title: string;
  summary: string | null;
  eventType: string;
  eventTier: string;
  sentiment: string;
  sentimentReasoning: string | null;
  rawPayload: unknown;
  publishedAt: string | null;
  receivedAt: string;
  createdAt: string;
  updatedAt: string;
  tickerImpacts: CatalystTickerImpact[];
};

export type CatalystTickerImpact = {
  id: string;
  catalystEventId: string;
  symbol: string;
  catalystRole: string | null;
  sentiment: string;
  sentimentReasoning: string | null;
  relevanceScore: number;
  actionabilityScore: number;
  freshnessScore: number;
  sourceQualityScore: number;
  totalCatalystScore: number;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MomentumCandidateState =
  | "DISCOVERED"
  | "WATCHING"
  | "ENTRY_READY"
  | "ENTRY_BLOCKED"
  | "EXPIRED"
  | "DISMISSED";

export type MomentumCandidate = {
  id: string;
  symbol: string;
  state: MomentumCandidateState;
  catalystEventId: string | null;
  catalystImpactId: string | null;
  totalScore: number;
  catalystScore: number;
  priceActionScore: number;
  volumeScore: number;
  riskScore: number;
  reason: string | null;
  blockedReason: string | null;
  discoveredAt: string;
  lastEvaluatedAt: string | null;
  expiresAt: string | null;
  rawSnapshot: unknown;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  catalystEvent?: CatalystEvent | null;
  catalystImpact?: CatalystTickerImpact | null;
};

export type MomentumCandidatePriceCheck = {
  id: string;
  momentumCandidateId: string;
  symbol: string;
  observedAt: string;
  lastPrice: string | number | null;
  previousClose: string | number | null;
  pctFromPreviousClose: string | number | null;
  intradayHigh: string | number | null;
  intradayLow: string | number | null;
  distanceFromHighPct: string | number | null;
  sessionVwap: string | number | null;
  aboveVwap: boolean | null;
  dayVolume: string | number | null;
  dollarVolume: string | number | null;
  relativeVolume: string | number | null;
  recentMovePct: string | number | null;
  recentVolume: string | number | null;
  confirmed: boolean;
  decision: string;
  blockedReason: string | null;
  rawPayload: unknown;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
};

export type MomentumScannerHandoffStatus =
  | "PENDING"
  | "SENT"
  | "ACKNOWLEDGED"
  | "FAILED"
  | "CANCELLED";

export type MomentumScannerHandoffPayload = {
  type?: string;
  version?: string;
  idempotencyKey?: string;
  candidate?: JsonRecord;
  catalyst?: JsonRecord | null;
  priceConfirmation?: JsonRecord | null;
  reviewGuidance?: JsonRecord;
  [key: string]: unknown;
};

export type MomentumScannerHandoff = {
  id: string;
  momentumCandidateId: string;
  symbol: string;
  status: MomentumScannerHandoffStatus;
  payloadVersion: string;
  payload: MomentumScannerHandoffPayload;
  idempotencyKey: string;
  attempts: number;
  preparedAt: string;
  sentAt: string | null;
  acknowledgedAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  momentumCandidate?: MomentumCandidate | null;
};

export type RunMassiveNewsWorkerResponse = {
  ok: boolean;
  result: unknown;
};

export type GenerateMomentumCandidatesResponse = {
  evaluatedImpacts: number;
  generatedCandidates: number;
  minCatalystScore: number;
  recentSince: string;
  expiresAt: string;
  candidates: MomentumCandidate[];
};

export type ConfirmMomentumPricesResponse = {
  checked?: number;
  confirmed?: number;
  blocked?: number;
  skipped?: number;
  results?: Array<{
    candidate: MomentumCandidate;
    priceCheck: MomentumCandidatePriceCheck;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type PrepareMomentumScannerHandoffsResponse = {
  prepared: number;
  skipped: number;
  handoffs: MomentumScannerHandoff[];
  skippedReasons: Array<{
    candidateId: string;
    symbol: string;
    reason: string;
  }>;
};
import type { AssetType } from "../securities/types";

export type MomentumUniverseReason =
  | "MANUAL"
  | "SUBSCRIPTION"
  | "OPEN_POSITION"
  | "DISCOVERY"
  | "IMPORTED";

export type MomentumUniverseCursor = {
  source: "MASSIVE_NEWS";
  enabled: boolean;
  lastPulledAt: string | null;
  lastPublishedAt: string | null;
  consecutiveErrors: number;
  lastError: string | null;
};

export type MomentumUniverseMember = {
  id: string;
  securityId: number;
  enabled: boolean;
  priority: number;
  newsEnabled: boolean;
  priceScanningEnabled: boolean;
  pullIntervalMin: number;
  addedReason: MomentumUniverseReason;
  notes: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  security: {
    id: number;
    symbol: string;
    name: string;
    enabled: boolean;
    assetType: AssetType;
  };
  subscriptionCount: number;
  cursor: MomentumUniverseCursor | null;
};

export type MomentumUniverseQuery = {
  enabled?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
};

export type MomentumUniverseResponse = {
  data: MomentumUniverseMember[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

export type MomentumResearchCandidateRow = {
  id: string;
  symbol: string;
  state: MomentumCandidateState;
  scores: {
    catalyst: number;
    priceAction: number;
    volume: number;
    risk: number;
    total: number;
  };
  reason: string | null;
  blockedReason: string | null;
  discoveredAt: string;
  lastEvaluatedAt: string | null;
  updatedAt: string;
  activityAt: string;
  expiresAt: string | null;
  entryReady: boolean;
  blocked: boolean;
  catalyst: {
    id: string;
    title: string;
    source: string;
    sourcePublisher: string | null;
    sourceUrl: string | null;
    publishedAt: string | null;
    eventType: string;
    eventTier: string;
    sentiment: string;
  } | null;
  latestPriceCheck: MomentumCandidatePriceCheck | null;
  latestHandoff: {
    id: string;
    status: MomentumScannerHandoffStatus;
    preparedAt: string;
  } | null;
  security: {
    id: number;
    symbol: string;
    name: string;
    assetType: AssetType;
    enabled: boolean;
  } | null;
  universe: {
    id: string;
    enabled: boolean;
    newsEnabled: boolean;
    priceScanningEnabled: boolean;
  } | null;
  tradingAvailability: {
    subscriptionCount: number;
    enabledSubscriptionCount: number;
  };
};

export type MomentumResearchCatalystRow = {
  id: string;
  title: string;
  source: string;
  sourceUrl: string | null;
  sourcePublisher: string | null;
  publishedAt: string | null;
  receivedAt: string;
  eventType: string;
  eventTier: string;
  sentiment: string;
  impactedSymbols: string[];
  candidateCount: number;
  momentumCandidates: Array<{
    id: string;
    symbol: string;
    state: MomentumCandidateState;
  }>;
};

export type MomentumResearchOverview = {
  windows: {
    recentCatalystsSince: string;
    recentCandidateActivitySince: string;
    asOf: string;
  };
  summary: {
    activeCandidates: number;
    entryReadyCandidates: number;
    blockedCandidates: number;
    recentCatalysts: number;
    preparedHandoffs: number;
    enabledUniverseMembers: number;
  };
  topCandidates: MomentumResearchCandidateRow[];
  recentCatalysts: MomentumResearchCatalystRow[];
  recentCandidateActivity: MomentumResearchCandidateRow[];
  scannerHealth: {
    enabledCursorCount: number;
    healthyCursorCount: number;
    errorCursorCount: number;
    dueCursorCount: number;
    lastNewsPullAt: string | null;
    lastCandidateGenerationActivityAt: string | null;
    lastPriceConfirmationActivityAt: string | null;
  };
};

export type ResearchPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type MomentumResearchCandidatesQuery = {
  page?: number;
  pageSize?: number;
  search?: string;
  state?: MomentumCandidateState;
  minTotalScore?: number;
  catalystType?: string;
  entryReady?: boolean;
  blocked?: boolean;
  from?: string;
  to?: string;
  sortBy?: "lastEvaluatedAt" | "updatedAt" | "discoveredAt" | "totalScore" | "symbol";
  sortDirection?: "asc" | "desc";
};

export type MomentumResearchCandidatesResponse = {
  data: MomentumResearchCandidateRow[];
  pagination: ResearchPagination;
};

export type MomentumResearchCatalystsQuery = {
  page?: number;
  pageSize?: number;
  search?: string;
  publisher?: string;
  source?: string;
  catalystType?: string;
  tier?: string;
  sentiment?: string;
  from?: string;
  to?: string;
  sortBy?: "publishedAt" | "receivedAt" | "updatedAt";
  sortDirection?: "asc" | "desc";
};

export type MomentumResearchCatalystsResponse = {
  data: MomentumResearchCatalystRow[];
  pagination: ResearchPagination;
};

export type CreateMomentumUniverseMemberRequest = {
  securityId: number;
};

export type UpdateMomentumUniverseMemberRequest = Partial<
  Pick<
    MomentumUniverseMember,
    | "enabled"
    | "priority"
    | "newsEnabled"
    | "priceScanningEnabled"
    | "pullIntervalMin"
    | "notes"
  >
>;
