import { apiRequest } from "../../lib/api";
import type { RuntimeTradingConfig } from "../dashboard/types";

export function getConfig(token: string) {
  return apiRequest<RuntimeTradingConfig>("/api/config", { token });
}

export function updateConfig(
  token: string,
  payload: Partial<RuntimeTradingConfig>
) {
  return apiRequest<RuntimeTradingConfig>("/api/config/settings", {
    method: "PATCH",
    token,
    body: payload,
  });
}

export type SystemStatusResponse = {
  ok: boolean;
  health: {
    ok: boolean;
    service: string;
    environment: string;
    uptimeSeconds: number;
    database: {
      ok: boolean;
      message: string;
    };
    timestamp: string;
  };
  environment: {
    nodeEnv: string;
    port: string | null;
    hasDatabaseUrl: boolean;
    hasAlpacaApiKey: boolean;
    hasAlpacaSecretKey: boolean;
    hasAlpacaBaseUrl: boolean;
    hasAdminJwtSecret: boolean;
    hasSignalApiKey: boolean;
  };
  trading: {
    config: {
      tradingEnabled: boolean;
      paperMode: boolean;
      killSwitchEnabled: boolean;
      maxDailyEntryOrders: number | null;
      maxDailyEntryNotional: number | null;
      maxOpenPositions: number | null;
      maxTotalOpenNotional: number | null;
      maxSymbolOpenNotional: number | null;
      maxSubscriptionOpenNotional: number | null;
    };
    risk: {
      canEnter: boolean;
      reasons: string[];
      broker: {
        name: string;
        mode: "paper" | "live";
        expectedMode: "paper" | "live";
        tradingBlocked: boolean;
      };
    };
  };
  workers: {
    tradingLoopSeconds: number;
    accountSnapshotCheckSeconds: number;
    brokerActivitySyncSeconds: number;
    pendingOrderCount: number;
    submittingOrderCount: number;
    submittedOrderCount: number;
    openTrackedPositionCount: number;
    closingTrackedPositionCount: number;
    unprocessedSystemEventCount: number;
  };
  audit: {
    latestAccountSnapshot: {
      createdAt: string;
      reason: string;
    } | null;
    latestBrokerActivity: {
      transactionTime: string | null;
      symbol: string | null;
      side: string | null;
      activityType: string;
    } | null;
  };
  timestamp: string;
};

export function getSystemStatus(token: string) {
  return apiRequest<SystemStatusResponse>("/api/system-status", { token });
}
