export type CurrentMarketState = {
  id: number;
  marketBias: string;
  riskMode: string;
  macroSummary: string | null;
  watchFor: string | null;
  avoidBecause: string | null;
  notes: string | null;
  source: string;
  validUntil: string | null;
  lastLlmRunAt: string | null;
  payloadJson: unknown | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketDiaryEvent = {
  id: number;
  eventType: string;
  source: string;
  symbol: string | null;
  summary: string;
  details: string | null;
  symbolsJson: unknown | null;
  payloadJson: unknown | null;
  createdAt: string;
};