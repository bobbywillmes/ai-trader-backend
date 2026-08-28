import { describe, expect, it } from "vitest";
import { operationalAttentionBadgeLabel } from "./badgeAccessibility";
describe("Operational Attention badge semantics", () => {
  it("describes one unresolved item and highest severity", () => expect(operationalAttentionBadgeLabel(1, "ERROR")).toBe("1 unresolved operational attention item; highest severity ERROR"));
  it("pluralizes unresolved items without calling them unread", () => { const label = operationalAttentionBadgeLabel(2, "WARNING"); expect(label).toBe("2 unresolved operational attention items; highest severity WARNING"); expect(label).not.toContain("unread"); });
});
