import { describe, expect, it } from "vitest";
import {
  canLaunchPaperExercise,
  DEFAULT_LIFECYCLE_EXERCISE_REASON,
  formatLifecycleExerciseName,
  isLifecyclePreviewValid,
  selectionModeLabel,
  updateGeneratedExerciseName,
  validatedAssignmentIds,
} from "./exerciseForm";
import type { SubscriptionEntryCandidate } from "./types";

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

  it("requires explicit Paper launch confirmation", () => {
    expect(canLaunchPaperExercise(false)).toBe(false);
    expect(canLaunchPaperExercise(true)).toBe(true);
  });

  it("only permits a non-expired preview to remain launch eligible", () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    expect(isLifecyclePreviewValid("PREVIEWED", "2026-07-28T12:05:00.000Z", now)).toBe(true);
    expect(isLifecyclePreviewValid("PREVIEWED", "2026-07-28T11:59:59.000Z", now)).toBe(false);
    expect(isLifecyclePreviewValid("RUNNING", "2026-07-28T12:05:00.000Z", now)).toBe(false);
  });

  it("constructs exact preview IDs only from current selectable PAPER candidates", () => {
    const candidate = (id: number, environment: "PAPER" | "LIVE", selectable: boolean): SubscriptionEntryCandidate => ({
      tradingAccountSubscriptionId: id, subscriptionId: 7, tradingAccountId: id + 100,
      subscription: { key: "spy", displayName: "SPY" },
      tradingAccount: { displayName: `Account ${id}`, environment, status: "ACTIVE", tradingEnabled: true, killSwitchEnabled: false, credentialStatus: "ACTIVE" },
      accountHolder: { id, name: `Holder ${id}`, email: `holder${id}@example.com`, enabled: true }, accessMembers: [],
      assignment: { enabled: true, entriesEnabled: true, exitsEnabled: true, sizingType: "FIXED_QTY", fixedQty: 1, maxPositionNotional: null, reservedNotional: null, minPositionNotional: null, maxQty: null },
      allocation: { id, key: `allocation-${id}`, displayName: `Allocation ${id}`, enabled: true }, selectable, unavailableReasons: [],
    });
    const candidates = [candidate(4, "PAPER", true), candidate(8, "PAPER", false), candidate(9, "LIVE", true), candidate(10, "PAPER", true)];
    expect(validatedAssignmentIds(candidates, [4, 8, 9, 10, 999])).toEqual([4, 10]);
    expect(validatedAssignmentIds(candidates, [4, 4])).toEqual([4]);
  });

  it("caps exact assignment validation at 25 without adding newly eligible targets", () => {
    const candidates = Array.from({ length: 30 }, (_, index) => ({
      tradingAccountSubscriptionId: index + 1, selectable: true,
      tradingAccount: { environment: "PAPER" },
    })) as SubscriptionEntryCandidate[];
    expect(validatedAssignmentIds(candidates, candidates.map((row) => row.tradingAccountSubscriptionId))).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(validatedAssignmentIds(candidates, [2, 29])).toEqual([2, 29]);
  });

  it("uses durable friendly selection labels", () => {
    expect(selectionModeLabel("EXPLICIT_ASSIGNMENTS")).toBe("Selected TradingAccounts");
    expect(selectionModeLabel("SELECTED_USERS")).toBe("Selected users");
    expect(selectionModeLabel("ALL_ELIGIBLE")).toBe("All eligible users/accounts");
  });
});
