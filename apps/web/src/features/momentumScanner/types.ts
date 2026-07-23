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
  priceActionScore: number;
  volumeScore: number;
  riskScore: number;
  totalConfirmationScore: number;
  confirmed: boolean;
  decision: string;
  blockedReason: string | null;
  scoringVersion: string | null;
  scoringInputs: unknown;
  scoreExplanation: unknown;
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
  momentumSubscriptionEligibility: {
    eligible: boolean;
    subscriptionCount: number;
    enabledSubscriptionCount: number;
    qualifyingSubscriptionIds: number[];
    reasons: string[];
  };
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
    priceAction: number | null;
    volume: number | null;
    risk: number | null;
    total: number;
  };
  evaluated: boolean;
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
  eligibility: {
    momentumSubscriptionEligibility: {
      eligible: boolean;
      qualifyingSubscriptionIds: number[];
      reasons: string[];
    };
    priceConfirmationEligible: boolean;
    handoffEligible: boolean;
    priceConfirmationReasons: string[];
    handoffReasons: string[];
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
  eligibilitySummary: {
    universeMembersEnabled: number;
    universeMembersWithActiveMomentumSubscriptions: number;
    researchOnlyMembers: number;
    enabledMomentumSubscriptionsOutsideUniverse: number;
    activeCandidatesOutsideUniverse: number;
    activeCandidatesWithoutValidSecurities: number;
    activeCandidatesWithoutMomentumSubscriptions: number;
    priceConfirmationEligibleCandidates: number;
    handoffEligibleCandidates: number;
    staleCandidatesAwaitingExpiration: number;
    bounded: { limit: number; securitiesTruncated: boolean; candidatesTruncated: boolean };
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

export type MomentumResearchCandidateDetail = {
  candidate: MomentumCandidate & {
    catalystEvent: (CatalystEvent & {
      sourceAuthor?: string | null;
      bodyExcerpt?: string | null;
      confidence?: number | null;
    }) | null;
    catalystImpact: CatalystTickerImpact | null;
    priceChecks: MomentumCandidatePriceCheck[];
    scannerHandoffs: Array<{
      id: string;
      symbol: string;
      status: MomentumScannerHandoffStatus;
      payloadVersion: string;
      preparedAt: string;
      sentAt: string | null;
      acknowledgedAt: string | null;
      failedAt: string | null;
      attempts: number;
      lastError: string | null;
      idempotencyKey: string;
      metadata: unknown;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  eligibility: MomentumResearchCandidateRow["eligibility"];
  security: {
    id: number;
    symbol: string;
    name: string;
    assetType: AssetType;
    enabled: boolean;
    sector: string | null;
    industry: string | null;
  } | null;
  universeMembership: {
    id: string;
    enabled: boolean;
    newsEnabled: boolean;
    priceScanningEnabled: boolean;
    priority: number;
    pullIntervalMin: number;
    addedReason: MomentumUniverseReason;
    notes: string | null;
  } | null;
  subscriptions: Array<{
    id: number;
    key: string;
    name: string;
    enabled: boolean;
    accountSubscriptions: Array<{
      id: number;
      enabled: boolean;
      entriesEnabled: boolean;
      exitsEnabled: boolean;
      tradingAccount: {
        id: number;
        displayName: string;
        environment: "PAPER" | "LIVE";
        status: string;
      };
      allocation: {
        id: number;
        enabled: boolean;
      } | null;
    }>;
  }>;
  tradingContext: {
    hasEnabledSubscription: boolean;
    openPositions: Array<{ id: number; status: string; qty: number; avgEntryPrice: number }>;
  };
  cursorHealth: string | null;
};

export type MomentumSymbolResearch = {
  security: NonNullable<MomentumResearchCandidateDetail["security"]>;
  researchStatus: {
    universeMember: boolean;
    universeEnabled: boolean;
    newsEnabled: boolean;
    priceScanningEnabled: boolean;
    cursorHealth: string | null;
    lastNewsPullAt: string | null;
    universeMembership: MomentumResearchCandidateDetail["universeMembership"];
    newsCursors: Array<{
      id: string;
      source: string;
      enabled: boolean;
      priority: number;
      pullIntervalMin: number;
      lastPulledAt: string | null;
      lastPublishedAt: string | null;
      consecutiveErrors: number;
      lastError: string | null;
      updatedAt: string;
    }>;
  };
  eligibility: {
    researchEligibility: {
      eligible: boolean;
      inUniverse: boolean;
      universeEnabled: boolean;
      newsEnabled: boolean;
      priceScanningEnabled: boolean;
      reasons: string[];
    };
    momentumSubscriptionEligibility: {
      eligible: boolean;
      subscriptionCount: number;
      enabledSubscriptionCount: number;
      qualifyingSubscriptionIds: number[];
      reasons: string[];
    };
    candidateEligibility: {
      discoveryEligible: boolean;
      priceConfirmationEligible: boolean;
      handoffEligible: boolean;
      priceConfirmationReasons: string[];
      handoffReasons: string[];
    };
  };
  tradingContext: {
    subscriptions: MomentumResearchCandidateDetail["subscriptions"];
    hasEnabledSubscription: boolean;
    openPositions: Array<{
      id: number;
      broker: string;
      symbol: string;
      side: string;
      qty: number;
      avgEntryPrice: number;
      currentPrice: number;
      marketValue: number;
      unrealizedPnL: number;
      unrealizedPnLPct: number;
      status: string;
      openedAt: string;
      lastSyncedAt: string;
    }>;
    hasOpenPosition: boolean;
  };
  currentCandidate: MomentumResearchCandidateDetail["candidate"] | null;
  recentCandidates: MomentumResearchCandidateDetail["candidate"][];
  recentCatalysts: Array<{
    id: string;
    source: string;
    sourceUrl: string | null;
    sourcePublisher: string | null;
    title: string;
    summary: string | null;
    publishedAt: string | null;
    receivedAt: string;
    eventType: string;
    eventTier: string;
    sentiment: string;
    confidence: number | null;
    tickerImpacts: CatalystTickerImpact[];
    momentumCandidates: Array<{
      id: string;
      state: MomentumCandidateState;
      totalScore: number;
      discoveredAt: string;
    }>;
  }>;
  priceChecks: MomentumCandidatePriceCheck[];
  handoffs: MomentumResearchCandidateDetail["candidate"]["scannerHandoffs"];
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

export type MomentumMarketChartInterval = "1m" | "5m" | "15m" | "1d";

export type MomentumMarketChartQuery = {
  interval: MomentumMarketChartInterval;
  from?: string;
  to?: string;
  candidateId?: string;
};

export type MomentumMarketChartMarkerType =
  | "CATALYST_PUBLISHED"
  | "CATALYST_RECEIVED"
  | "CANDIDATE_DISCOVERED"
  | "PRICE_CHECK"
  | "ENTRY_READY"
  | "ENTRY_BLOCKED"
  | "HANDOFF_PREPARED"
  | "HANDOFF_SENT"
  | "HANDOFF_CANCELLED";

export type MomentumMarketChartResponse = {
  security: { id: string; symbol: string; name: string };
  query: {
    interval: MomentumMarketChartInterval;
    from: string;
    to: string;
    timezone: "America/New_York";
    adjusted: boolean;
  };
  bars: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: string | null;
    vwap: number | null;
    transactions: number | null;
  }>;
  referenceLevels: {
    previousClose: number | null;
    sessionVwap: number | null;
    premarketHigh: number | null;
    regularSessionHigh: number | null;
  };
  markers: Array<{
    id: string;
    type: MomentumMarketChartMarkerType;
    timestamp: string;
    price: number | null;
    label: string;
    candidateId: string | null;
    metadata?: Record<string, unknown>;
  }>;
  source: {
    provider: "MASSIVE";
    fetchedAt: string;
    cached: boolean;
  };
};

export type ExpireMomentumCandidatesResponse = {
  inspected: number;
  expired: number;
  unchanged: number;
  skipped: number;
  staleRemaining: number;
  expiredCandidateIds: string[];
  expiredCandidateIdsTruncated: boolean;
  reasonCounts: Record<string, number>;
  asOf: string;
};

export type MomentumPipelineRunStatus = "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "ABANDONED";
export type MomentumPipelineRunSource = "N8N_SCHEDULED" | "N8N_MANUAL" | "ADMIN_MANUAL";
export type MomentumPipelineStage = "NEWS" | "EXPIRATION" | "CANDIDATE_GENERATION" | "PRICE_CONFIRMATION" | "HANDOFF_PREPARATION" | "HANDOFF_DELIVERY";

export type MomentumPipelineRun = {
  id: string;
  source: MomentumPipelineRunSource;
  status: MomentumPipelineRunStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  currentStage: MomentumPipelineStage | null;
  errorStage: MomentumPipelineStage | null;
  errorCode: string | null;
  errorMessage: string | null;
  newsResult: unknown;
  expirationResult: unknown;
  candidateResult: unknown;
  priceResult: unknown;
  handoffResult: unknown;
  deliveryResult: unknown;
};

export type MomentumPipelineLatestResponse = {
  latestAttempt: MomentumPipelineRun | null;
  latestSuccessful: MomentumPipelineRun | null;
  currentRun: MomentumPipelineRun | null;
};

export type MomentumPipelineRunsResponse = {
  data: MomentumPipelineRun[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

export type FullMomentumPipelineRequest = {
  metadata?: Record<string, unknown>;
  expirationLimit?: number;
  minCatalystScore?: number;
  candidateTake?: number;
  expiresInHours?: number;
  maxCandidates?: number;
  minHandoffScore?: number;
};

export type FullMomentumPipelineResponse = {
  runId: string;
  status: MomentumPipelineRunStatus;
  startedAt: string;
  completedAt: string;
  failedStage?: MomentumPipelineStage;
  errorCode?: string;
  errorMessage?: string;
  stages: Partial<Record<MomentumPipelineStage, Record<string, unknown>>>;
};
