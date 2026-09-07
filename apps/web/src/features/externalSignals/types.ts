// HTTP DTOs follow the existing feature-local convention (dates are ISO strings).
export const providers = ["TRADINGVIEW", "TRENDSPIDER", "GENERIC_WEBHOOK"] as const;
export type Provider = typeof providers[number];
export const events = ["ENTRY_LONG", "EXIT_LONG"] as const;
export const statuses = ["NORMALIZED", "DUPLICATE", "REJECTED"] as const;
export const timeframes = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
export const rejectionCodes = ["SOURCE_DISABLED", "INVALID_CONTENT_TYPE", "INVALID_JSON", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_SCHEMA_VERSION", "INVALID_ENVELOPE", "UNKNOWN_STRATEGY_BINDING", "STRATEGY_BINDING_DISABLED", "STRATEGY_REVISION_MISMATCH", "UNKNOWN_SYMBOL", "INVALID_EVENT", "INVALID_TIMEFRAME", "INVALID_TIMESTAMP", "EVENT_KEY_CONFLICT"] as const;
export type Source = { id: number; name: string; provider: Provider; enabled: boolean; authMethod: "URL_TOKEN"; createdAt: string; updatedAt: string };
export type Binding = { id: number; signalSourceId: number; strategyId: number; externalStrategyKey: string; expectedRevision: string; enabled: boolean; createdAt: string; updatedAt: string };
export type Signal = {
  id: number; signalSourceId: number; strategySignalBindingId: number; strategyId: number; securityId: number;
  schemaVersion: number; externalEventKey: string; strategyRevision: string; event: typeof events[number];
  symbol: string; timeframe: string; signalTime: string; barTime: string | null; metadata: unknown;
  canonicalPayloadHash: string; createdAt: string;
};
export type Delivery = {
  id: number; signalSourceId: number; signalId: number | null; requestId: string;
  receivedAt: string; processedAt: string; status: typeof statuses[number]; contentType: string | null;
  bodySizeBytes: number; rawPayloadHash: string; rawPayloadRedacted: unknown;
  rejectionCode: typeof rejectionCodes[number] | null; rejectionDetails: unknown; createdAt: string;
};
export type Resources = { sources: Source; bindings: Binding; signals: Signal; deliveries: Delivery };
export type Section = keyof Resources;
export type Pagination = { page: number; pageSize: number; total: number; totalPages: number };
export type ListResult<K extends Section> = { [P in K]: Resources[P][] } & { pagination: Pagination };
export type CreateSource = Pick<Source, "name" | "provider"> & { enabled: boolean };
export type UpdateSource = Partial<Pick<Source, "name" | "enabled">>;
export type CreateBinding = Pick<Binding, "signalSourceId" | "strategyId" | "externalStrategyKey" | "expectedRevision" | "enabled">;
export type UpdateBinding = Pick<Binding, "expectedRevision" | "enabled">;
export type Credential = { source: Source; token: string; rotated: boolean };
