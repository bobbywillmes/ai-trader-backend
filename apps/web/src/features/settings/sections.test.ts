import { describe, expect, it } from "vitest";
import { getSettingsSection, settingsSectionParams } from "./sections";

describe("settings section routing", () => {
  it("defaults invalid and missing values to system status", () => {
    expect(getSettingsSection(null)).toBe("status");
    expect(getSettingsSection("legacy-risk")).toBe("status");
  });

  it("preserves unrelated query state while linking sections", () => {
    const params = settingsSectionParams(new URLSearchParams("context=ops"), "integrity");
    expect(params.toString()).toBe("context=ops&section=integrity");
    expect(settingsSectionParams(params, "status").toString()).toBe("context=ops");
  });
});
