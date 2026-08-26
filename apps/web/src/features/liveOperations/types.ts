export type OperationalHealth = "HEALTHY" | "DEGRADED" | "ACTION_REQUIRED" | "UNKNOWN";
export type LiveOperationsResponse = {
  generatedAt: string;
  environmentContext: { applicationEnvironment: "development" | "test" | "production"; deploymentRole: "OBSERVATION_ONLY" | "PRODUCTION_EXECUTOR"; operationalAuthority: "AUTHORITATIVE_EXECUTOR" | "OBSERVATION_ONLY"; healthScope: "CURRENT_ENVIRONMENT_ONLY"; liveEntryWritePolicy: "ALLOWED" | "OBSERVATION_ONLY"; liveRiskReducingWritePolicy: "ALLOWED" | "OBSERVATION_ONLY" };
  summary: { liveAccountCount: number; accountsWithExposure: number; openPositionCount: number; accountsRequiringAttention: number; accountsDegradedOrStale: number; accountsObservationLimited: number; accountsWithActiveEntryArming: number; health: OperationalHealth };
  accounts: LiveAccountOperations[];
};
export type LiveAccountOperations = {
  account: { id: number; displayName: string; broker: string; environment: "LIVE"; status: string };
  generatedAt: string; health: OperationalHealth; operationalState: OperationalHealth | "OBSERVATION_ONLY"; summary: string;
  exposure: { openPositionCount: number };
  positions: Array<{ id: number; symbol: string; qty: number; avgEntryPrice: number | null; status: string; lastSyncedAt: string; brokerLocalAgreement: string; lifecycleState: string; productionHealth: string; observerLimitation: { code: "EXPECTED_OBSERVATION_LIMITATION"; title: string; message: string; causalChain: string[] } | null; attribution: { resolved: boolean; finding: string; assignmentId: number | null; assignmentKey: string | null; subscriptionId: number | null; configSnapshotPresent: boolean }; exitProfile: { id: number; key: string; name: string; mode: string } | null; exitEvaluation: { applicable: boolean; eligible: boolean; health: string; lastSuccessAt: string | null; freshness: string }; actionDue: boolean; activeOrderIntent: { id: number; status: string; blockReason: string | null; brokerOrder: { id: number; status: string } | null } | null; expectation: string; attentionReasons: string[] }>;
  positionLifecycle: { health: OperationalHealth; state: string };
  exitCapability: { state: string; actionDue: boolean; strategyResolved: boolean; evaluatorHealth: string; authorizationActive: boolean; environmentWritePolicy: string };
  reconciliation: { health: OperationalHealth; state: string; findingCount: number | null; freshness: string; evidenceAt: string | null; context: string | null };
  workers: { health: OperationalHealth; items: Array<{ key: string; status: string; freshness: string; evidenceAt: string | null; reason: string | null }> };
  entryPosture: { state: string; authorizationActive: boolean; armingId: number | null };
  safetyPosture: { tradingEnabled: boolean; killSwitchEnabled: boolean; riskReducingAuthorization: string; entryAuthorization: string; deploymentRole: string; liveRiskReducingWritesAllowed: boolean; exclusiveWriterOwnershipProven: false };
  completedCanary: { id: number; completedAt: string | null } | null;
  attentionReasons: string[]; nextOperatorAction: { code: string; message: string };
};
