export type ExerciseStatus = "PREVIEWED" | "LAUNCHING" | "RUNNING" | "BLOCKED" | "PARTIAL" | "COMPLETED" | "FAILED" | "CANCELLED" | "ATTENTION_REQUIRED";
export type ExerciseSelectionMode = "SELECTED_USERS" | "ALL_ELIGIBLE" | "EXPLICIT_ASSIGNMENTS";
export type ExerciseType = "SUBSCRIPTION_ENTRY";
export type Issue = { code: string; message: string };

export type SubscriptionEntryCandidate = {
  tradingAccountSubscriptionId: number; subscriptionId: number; tradingAccountId: number;
  subscription: { key: string; displayName: string };
  tradingAccount: { displayName: string; environment: "PAPER" | "LIVE"; status: string; tradingEnabled: boolean; killSwitchEnabled: boolean; credentialStatus: string | null };
  accountHolder: { id: number; name: string | null; email: string; enabled: boolean };
  accessMembers: Array<{ id: number; name: string | null; email: string; enabled: boolean }>;
  assignment: { enabled: boolean; entriesEnabled: boolean; exitsEnabled: boolean; sizingType: string; fixedQty: number | null; maxPositionNotional: number | null; reservedNotional: number | null; minPositionNotional: number | null; maxQty: number | null };
  allocation: { id: number; key: string; displayName: string; enabled: boolean } | null;
  selectable: boolean; unavailableReasons: Issue[];
};
export type SubscriptionEntryCandidatesResponse = { subscription: { id: number; key: string; displayName: string }; candidates: SubscriptionEntryCandidate[] };

export type LifecycleExerciseTarget = {
  id: number;
  tradingAccountId: number;
  tradingAccountSubscriptionId: number;
  status: string;
  blockersJson: Issue[];
  warningsJson: Issue[];
  readinessJson?: {
    positionSlotUsage?: {
      accountMaxPositions: number | null;
      activePositionCount: number;
      pendingEntryIntentSlotCount: number;
      usedSlots: number;
      proposedAdditionalSlots: number;
      projectedSlotCount: number;
    };
    context?: {
      allocation?: { key?: string; name?: string } | null;
      tradingAccount?: { displayName?: string };
    };
    sizing?: {
      qty?: number;
      estimatedNotional?: number;
      snapshot?: {
        sizingType?: string;
        fixedQty?: number | null;
        maxPositionNotional?: number | null;
        minPositionNotional?: number | null;
        maxQty?: number | null;
        latestPrice?: number | null;
        latestPriceAt?: string | null;
        latestPriceSource?: string | null;
      };
    };
    priceEvidence?: { observedAt?: string | null; source?: string | null };
    session?: {
      status?: string;
      rule?: string;
      marketOpen?: boolean | null;
      evaluatedAt?: string | null;
      entryAllowedAt?: string | null;
      nextOpenAt?: string | null;
    } | null;
    risk?: {
      allowed?: boolean;
      details?: {
        usage?: {
          activePositionCount?: number;
          pendingEntryPositionCount?: number;
          currentAccountPositionSlots?: number;
          currentAccountExposure?: number;
          projectedAccountExposure?: number;
        };
        effectiveEntryLimits?: {
          limits?: { maxOpenPositions?: { value?: number | null } };
          authoritativeTotalExposure?: { value?: number | null };
        };
        allocationRisk?: {
          allocationKey?: string;
          allocationName?: string;
          limits?: { maxAllocatedNotional?: number | null };
          usage?: { currentAllocatedNotional?: number; projectedAllocatedNotional?: number | null };
        } | null;
      } | null;
    };
  };
  resolvedQuantity: number | null;
  estimatedPrice: number | null;
  estimatedNotional: number | null;
  accountHolderUser?: { id: number; name: string | null; email: string };
  tradingAccount?: { id: number; displayName: string; environment: "PAPER" | "LIVE" };
  environment: "PAPER" | "LIVE";
  allocationSnapshotJson?: { id?: number; key?: string; displayName?: string; name?: string } | null;
  launchOutcome?: string | null; launchResultCode?: string | null; launchResultMessage?: string | null;
  launchAttemptedAt?: string | null; launchEvidenceJson?: Record<string, unknown> | null;
  dispatchStartedAt?: string | null;
  orderIntentId: number | null;
  reconciledAt: string | null;
  projection?: {
    stage: string;
    timeline: Array<{ key: string; type: string; at: string; label: string; entityType: string; entityId: number }>;
    links: { orderIntentId: number | null; brokerOrderIds: number[]; trackedPositionId: number | null; positionExitStateId: number | null };
    lifecycleContinuesAfterCancellation: boolean;
  };
};

export type LifecycleExercise = {
  id: number;
  name: string | null;
  reason: string;
  environment: "PAPER";
  exerciseType: ExerciseType;
  containsLiveTargets: boolean;
  previewVersion: number;
  previewFingerprint: string;
  status: ExerciseStatus;
  selectionMode: ExerciseSelectionMode;
  requestedUserIdsJson: number[];
  selectionResultsJson: Array<{ userId: number; outcome: string; code: string; name?: string; email?: string }>;
  summaryJson: Record<string, unknown> | null;
  previewedAt: string;
  previewExpiresAt: string;
  launchedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  subscription: { id: number; key: string; name: string };
  createdByUser: { id: number; name: string | null; email: string };
  targets?: LifecycleExerciseTarget[];
  _count?: { targets: number };
  recoveryApplicable?: boolean;
};

export type ExplicitAssignmentPreviewInput = { name?: string; reason: string; subscriptionId: number; tradingAccountSubscriptionIds: number[]; environment: "PAPER" };
export type DispatchRecoveryResponse = { exercise: LifecycleExercise; recovery: { staleBefore: string; results: Array<{ targetId: number; code: string; orderIntentId: number | null }> } };

export type PreviewExerciseInput = {
  name?: string;
  reason: string;
  subscriptionId: number;
  selectionMode: "SELECTED_USERS" | "ALL_ELIGIBLE";
  userIds?: number[];
  environment: "PAPER";
};
