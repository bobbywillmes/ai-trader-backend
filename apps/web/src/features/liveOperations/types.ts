export type OperationalHealth = "HEALTHY" | "DEGRADED" | "ACTION_REQUIRED" | "UNKNOWN";
export type LiveOperationsResponse = {
  generatedAt: string;
  summary: { liveAccountCount: number; accountsWithExposure: number; openPositionCount: number; accountsRequiringAttention: number; accountsDegradedOrStale: number; accountsWithActiveEntryArming: number; health: OperationalHealth };
  accounts: LiveAccountOperations[];
};
export type LiveAccountOperations = {
  account: { id: number; displayName: string; broker: string; environment: "LIVE"; status: string };
  generatedAt: string; health: OperationalHealth; summary: string;
  exposure: { openPositionCount: number };
  positions: Array<{ id: number; symbol: string; qty: number; avgEntryPrice: number | null; status: string; lastSyncedAt: string; brokerLocalAgreement: string; attribution: { resolved: boolean; assignmentId: number | null; assignmentKey: string | null; subscriptionId: number | null }; exitProfile: { id: number; key: string; name: string; mode: string } | null; exitEvaluation: { applicable: boolean; eligible: boolean; health: string; lastSuccessAt: string | null; freshness: string }; actionDue: boolean; activeOrderIntent: { id: number; status: string; blockReason: string | null; brokerOrder: { id: number; status: string } | null } | null; expectation: string; attentionReasons: string[] }>;
  positionLifecycle: { health: OperationalHealth };
  exitCapability: { state: string; actionDue: boolean; strategyResolved: boolean; evaluatorHealth: string; authorizationActive: boolean; environmentWritePolicy: string };
  reconciliation: { health: OperationalHealth; findingCount: number | null; freshness: string; evidenceAt: string | null };
  workers: { health: OperationalHealth; items: Array<{ key: string; status: string; freshness: string; evidenceAt: string | null; reason: string | null }> };
  entryPosture: { state: string; authorizationActive: boolean; armingId: number | null };
  safetyPosture: { tradingEnabled: boolean; killSwitchEnabled: boolean; riskReducingAuthorization: string; entryAuthorization: string; deploymentRole: string; liveRiskReducingWritesAllowed: boolean; exclusiveWriterOwnershipProven: false };
  completedCanary: { id: number; completedAt: string | null } | null;
  attentionReasons: string[]; nextOperatorAction: { code: string; message: string };
};
