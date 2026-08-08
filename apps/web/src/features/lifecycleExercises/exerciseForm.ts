import type { SubscriptionEntryCandidate } from "./types";

export const DEFAULT_LIFECYCLE_EXERCISE_REASON =
  "Controlled Paper lifecycle validation.";

export function formatLifecycleExerciseName(
  subscriptionName: string,
  now = new Date(),
) {
  const localDateTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(now);

  return `${subscriptionName} — Paper lifecycle — ${localDateTime}`;
}

export function validatedAssignmentIds(candidates: SubscriptionEntryCandidate[], selectedIds: readonly number[]) {
  const selected = new Set(selectedIds);
  return candidates.filter((candidate) => candidate.selectable && candidate.tradingAccount.environment === "PAPER" && selected.has(candidate.tradingAccountSubscriptionId)).map((candidate) => candidate.tradingAccountSubscriptionId).slice(0, 25);
}

export function selectionModeLabel(mode: "SELECTED_USERS" | "ALL_ELIGIBLE" | "EXPLICIT_ASSIGNMENTS") {
  if (mode === "EXPLICIT_ASSIGNMENTS") return "Selected TradingAccounts";
  if (mode === "ALL_ELIGIBLE") return "All eligible users/accounts";
  return "Selected users";
}

export function historySubscriptionOptions(exercises: readonly { subscription: { id: number; name: string } }[]) {
  return [...new Map(exercises.map((exercise) => [exercise.subscription.id, exercise.subscription])).values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((subscription) => ({ value: String(subscription.id), label: subscription.name }));
}

export function updateGeneratedExerciseName(input: {
  currentName: string;
  manuallyEdited: boolean;
  subscriptionName: string;
  now?: Date;
}) {
  return input.manuallyEdited
    ? input.currentName
    : formatLifecycleExerciseName(input.subscriptionName, input.now);
}

export function canLaunchPaperExercise(confirmed: boolean) {
  return confirmed;
}

export function isLifecyclePreviewValid(status: string, previewExpiresAt: string, now = new Date()) {
  return status === "PREVIEWED" && new Date(previewExpiresAt).getTime() > now.getTime();
}
