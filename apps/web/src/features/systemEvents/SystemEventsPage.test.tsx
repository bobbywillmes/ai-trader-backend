import { describe, expect, it } from "vitest";

import { systemEventTone } from "../dashboard/eventUtils";

describe("SystemEvent severity presentation", () => {
  it.each([
    ["INFO", "informational"],
    ["WARNING", "warning"],
    ["ERROR", "danger"],
    ["CRITICAL", "danger"],
  ] as const)("maps persisted %s severity to %s", (severity, tone) => {
    expect(systemEventTone({ severity })).toBe(tone);
  });

  it("does not infer severity from alarming event names", () => {
    expect(systemEventTone({ severity: "INFO" })).toBe("informational");
  });
});
