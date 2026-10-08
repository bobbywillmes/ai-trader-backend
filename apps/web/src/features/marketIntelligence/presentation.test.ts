import { describe, expect, it } from "vitest";
import { assessmentFreshness } from "./presentation";
import type { Assessment } from "./types";
const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({ id: 1, dimension: "TREND", algorithmVersion: "TREND_V1", evidenceSchemaVersion: 1, targetAt: "2026-10-07T20:00:00Z", sessionDate: "2026-10-07", attempt: 1, status: "VALID", reasonCode: null, rawState: "UP", effectiveState: "UP", dataThroughAt: "2026-10-07T20:00:00Z", validUntil: "2026-10-08T20:00:00Z", previousAssessmentId: null, startedAt: "2026-10-07T20:15:00Z", completedAt: "2026-10-07T20:15:01Z", createdAt: "2026-10-07T20:15:01Z", evidenceJson: {}, ...overrides });
describe("assessment freshness", () => {
  it("uses persisted validUntil without claiming expected-session currency", () => { expect(assessmentFreshness(assessment(), new Date("2026-10-08T19:59:00Z"))).toBe("AVAILABLE"); expect(assessmentFreshness(assessment(), new Date("2026-10-08T20:01:00Z"))).toBe("EXPIRED"); });
  it("preserves failed and unavailable latest attempts", () => { expect(assessmentFreshness(assessment({ status: "FAILED", validUntil: null }))).toBe("FAILED"); expect(assessmentFreshness(assessment({ status: "UNAVAILABLE", validUntil: null }))).toBe("UNAVAILABLE"); expect(assessmentFreshness(null)).toBe("NOT_PUBLISHED"); });
});
