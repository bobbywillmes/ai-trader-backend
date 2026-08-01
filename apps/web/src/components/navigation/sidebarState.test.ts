import { describe, expect, it } from "vitest";
import { contentOffsetFor, getInitialSidebarState, SIDEBAR_PINNED_STORAGE_KEY, transitionSidebar } from "./sidebarState";

describe("responsive sidebar state", () => {
  it("begins collapsed when no pinned preference exists", () => {
    expect(getInitialSidebarState({ getItem: () => null })).toBe("desktop-collapsed");
  });

  it("restores the pinned preference on remount", () => {
    const storage = { getItem: (key: string) => key === SIDEBAR_PINNED_STORAGE_KEY ? "true" : null };
    expect(getInitialSidebarState(storage)).toBe("desktop-pinned");
  });

  it("only offsets content for a pinned expansion", () => {
    expect(contentOffsetFor("desktop-collapsed")).toBe(72);
    expect(contentOffsetFor("desktop-hover-expanded")).toBe(72);
    expect(contentOffsetFor("desktop-pinned")).toBe(248);
    expect(contentOffsetFor("mobile-open")).toBe(0);
  });

  it("expands temporarily without changing a pinned state", () => {
    expect(transitionSidebar("desktop-collapsed", "temporary-open")).toBe("desktop-hover-expanded");
    expect(transitionSidebar("desktop-hover-expanded", "temporary-close")).toBe("desktop-collapsed");
    expect(transitionSidebar("desktop-pinned", "temporary-close")).toBe("desktop-pinned");
  });

  it("pins, unpins, and restores the preference after mobile closes", () => {
    expect(transitionSidebar("desktop-hover-expanded", "pin")).toBe("desktop-pinned");
    expect(transitionSidebar("desktop-pinned", "unpin")).toBe("desktop-collapsed");
    expect(transitionSidebar("desktop-collapsed", "mobile-open")).toBe("mobile-open");
    expect(transitionSidebar("mobile-open", "mobile-close", true)).toBe("desktop-pinned");
  });
});
