import { apiRequest } from "../../lib/api";
import type { DispatchRecoveryResponse, ExplicitAssignmentPreviewInput, LifecycleExercise, PreviewExerciseInput, SubscriptionEntryCandidatesResponse } from "./types";

export const listLifecycleExercises = (token: string) =>
  apiRequest<{ exercises: LifecycleExercise[] }>("/api/trading-lifecycle-exercises", { token });

export const getLifecycleExercise = (token: string, id: number) =>
  apiRequest<{ exercise: LifecycleExercise }>(`/api/trading-lifecycle-exercises/${id}`, { token });

export const previewLifecycleExercise = (token: string, input: PreviewExerciseInput) =>
  apiRequest<{ exercise: LifecycleExercise }>("/api/trading-lifecycle-exercises/preview", { method: "POST", token, body: input });

export const listSubscriptionEntryCandidates = (token: string, subscriptionId: number) =>
  apiRequest<SubscriptionEntryCandidatesResponse>(`/api/trading-lifecycle-exercises/subscription-entry/candidates?subscriptionId=${subscriptionId}`, { token });

export const previewExplicitAssignmentExercise = (token: string, input: ExplicitAssignmentPreviewInput) =>
  apiRequest<{ exercise: LifecycleExercise }>("/api/trading-lifecycle-exercises/subscription-entry/preview", { method: "POST", token, body: input });

export const launchLifecycleExercise = (token: string, id: number) =>
  apiRequest<{ exercise: LifecycleExercise }>(`/api/trading-lifecycle-exercises/${id}/launch`, { method: "POST", token, body: { confirmation: "LAUNCH PAPER EXERCISE" } });

export const cancelLifecycleExercise = (token: string, id: number, reason: string) =>
  apiRequest<{ exercise: LifecycleExercise; warning: string }>(`/api/trading-lifecycle-exercises/${id}/cancel`, { method: "POST", token, body: { reason } });

export const reconcileLifecycleTarget = (token: string, exerciseId: number, targetId: number) =>
  apiRequest(`/api/trading-lifecycle-exercises/${exerciseId}/targets/${targetId}/reconciliation`, { method: "POST", token });

export const recoverLifecycleExerciseDispatches = (token: string, exerciseId: number) =>
  apiRequest<DispatchRecoveryResponse>(`/api/trading-lifecycle-exercises/${exerciseId}/dispatch-recovery`, { method: "POST", token });
