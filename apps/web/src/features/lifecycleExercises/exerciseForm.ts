import type { PreviewExerciseInput } from "./types";

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

export function showsSelectedAccountHolders(
  selectionMode: "SELECTED_USERS" | "ALL_ELIGIBLE",
) {
  return selectionMode === "SELECTED_USERS";
}

export function canLaunchPaperExercise(confirmed: boolean) {
  return confirmed;
}

export function buildLifecycleExercisePreviewPayload(input: {
  name: string;
  reason: string;
  subscriptionId: string;
  selectionMode: "SELECTED_USERS" | "ALL_ELIGIBLE";
  userIds: string[];
}): PreviewExerciseInput {
  return {
    ...(input.name.trim() ? { name: input.name.trim() } : {}),
    reason: input.reason.trim(),
    subscriptionId: Number(input.subscriptionId),
    selectionMode: input.selectionMode,
    ...(input.selectionMode === "SELECTED_USERS"
      ? { userIds: input.userIds.map(Number) }
      : {}),
    environment: "PAPER",
  };
}
