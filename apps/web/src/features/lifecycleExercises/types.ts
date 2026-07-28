export type ExerciseStatus = "PREVIEWED" | "LAUNCHING" | "RUNNING" | "BLOCKED" | "PARTIAL" | "COMPLETED" | "FAILED" | "CANCELLED" | "ATTENTION_REQUIRED";

export type LifecycleExerciseTarget = {
  id: number;
  tradingAccountId: number;
  tradingAccountSubscriptionId: number;
  status: string;
  blockersJson: Array<{ code: string; message: string }>;
  warningsJson: Array<{ code: string; message: string }>;
  resolvedQuantity: number | null;
  estimatedPrice: number | null;
  estimatedNotional: number | null;
  accountHolderUser?: { id: number; name: string | null; email: string };
  tradingAccount?: { id: number; displayName: string; environment: "PAPER" };
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
  status: ExerciseStatus;
  selectionMode: "SELECTED_USERS" | "ALL_ELIGIBLE";
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
};

export type PreviewExerciseInput = {
  name?: string;
  reason: string;
  subscriptionId: number;
  selectionMode: "SELECTED_USERS" | "ALL_ELIGIBLE";
  userIds?: number[];
  environment: "PAPER";
};
