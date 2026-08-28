import { describe, expect, it } from "vitest";
import { applyAttentionStatusFilter, ATTENTION_STATUS_OPTIONS, readAttentionStatusFilter, statusApiValue } from "./statusFilter";

describe("Operational Attention URL status filters", () => {
  it("includes every requested status option", () => expect(ATTENTION_STATUS_OPTIONS.map(({ label }) => label)).toEqual(["All statuses", "Unresolved", "Open", "Acknowledged", "Resolved history"]));
  it.each([null, "unresolved", "OPEN,ACKNOWLEDGED"])('defaults %s to unresolved', (value) => expect(readAttentionStatusFilter(value)).toEqual({ value: "unresolved", invalid: false }));
  it.each(["all", "OPEN", "ACKNOWLEDGED", "RESOLVED"] as const)('restores %s from the URL', (value) => expect(readAttentionStatusFilter(value)).toEqual({ value, invalid: false }));
  it("normalizes invalid values to unresolved", () => expect(readAttentionStatusFilter("unread")).toEqual({ value: "unresolved", invalid: true }));
  it("uses one all-status server request", () => expect(statusApiValue("all")).toBe("all"));
  it("uses the explicit unresolved pair without changing summary semantics", () => expect(statusApiValue("unresolved")).toBe("OPEN,ACKNOWLEDGED"));
  it("uses the canonical status=all URL and resets pagination while preserving account and severity", () => {
    expect(applyAttentionStatusFilter(new URLSearchParams("account=2&severity=ERROR&page=4"), "all").toString()).toBe("account=2&severity=ERROR&page=1&status=all");
  });
  it("uses an omitted status as the canonical unresolved URL", () => {
    expect(applyAttentionStatusFilter(new URLSearchParams("account=all&severity=WARNING&status=RESOLVED&page=3"), "unresolved").toString()).toBe("account=all&severity=WARNING&page=1");
  });
});
