import { describe, expect, it } from "vitest";
import {
  buildLifecycleExercisePreviewPayload,
  canLaunchPaperExercise,
  DEFAULT_LIFECYCLE_EXERCISE_REASON,
  formatLifecycleExerciseName,
  showsSelectedAccountHolders,
  updateGeneratedExerciseName,
} from "./exerciseForm";

const localTime = new Date(2026, 6, 28, 4, 53);

describe("lifecycle exercise create form", () => {
  it("generates a useful Paper exercise name using the local date and time", () => {
    const formattedDate = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(localTime);

    expect(formatLifecycleExerciseName("SPY Dip Core", localTime)).toBe(
      `SPY Dip Core — Paper lifecycle — ${formattedDate}`,
    );
  });

  it("updates the generated name when the subscription changes before manual editing", () => {
    expect(updateGeneratedExerciseName({
      currentName: "SPY Dip Core — Paper lifecycle — old",
      manuallyEdited: false,
      subscriptionName: "RSP Core",
      now: localTime,
    })).toBe(formatLifecycleExerciseName("RSP Core", localTime));
  });

  it("preserves a custom or intentionally cleared name after manual editing", () => {
    expect(updateGeneratedExerciseName({
      currentName: "Morning Paper validation",
      manuallyEdited: true,
      subscriptionName: "RSP Core",
      now: localTime,
    })).toBe("Morning Paper validation");
    expect(updateGeneratedExerciseName({
      currentName: "",
      manuallyEdited: true,
      subscriptionName: "RSP Core",
      now: localTime,
    })).toBe("");
  });

  it("provides the editable default reason", () => {
    expect(DEFAULT_LIFECYCLE_EXERCISE_REASON).toBe(
      "Controlled Paper lifecycle validation.",
    );
  });

  it("shows selected users only for Selected users mode", () => {
    expect(showsSelectedAccountHolders("SELECTED_USERS")).toBe(true);
    expect(showsSelectedAccountHolders("ALL_ELIGIBLE")).toBe(false);
  });

  it("requires explicit Paper launch confirmation", () => {
    expect(canLaunchPaperExercise(false)).toBe(false);
    expect(canLaunchPaperExercise(true)).toBe(true);
  });

  it("builds selected-user and Everyone preview payloads without stale user IDs", () => {
    const selected = buildLifecycleExercisePreviewPayload({
      name: "RSP Paper check",
      reason: DEFAULT_LIFECYCLE_EXERCISE_REASON,
      subscriptionId: "42",
      selectionMode: "SELECTED_USERS",
      userIds: ["7", "9"],
    });
    expect(selected).toEqual({
      name: "RSP Paper check",
      reason: "Controlled Paper lifecycle validation.",
      subscriptionId: 42,
      selectionMode: "SELECTED_USERS",
      userIds: [7, 9],
      environment: "PAPER",
    });

    expect(buildLifecycleExercisePreviewPayload({
      name: "RSP Paper check",
      reason: DEFAULT_LIFECYCLE_EXERCISE_REASON,
      subscriptionId: "42",
      selectionMode: "ALL_ELIGIBLE",
      userIds: ["7", "9"],
    })).toEqual({
      name: "RSP Paper check",
      reason: "Controlled Paper lifecycle validation.",
      subscriptionId: 42,
      selectionMode: "ALL_ELIGIBLE",
      environment: "PAPER",
    });
  });
});
