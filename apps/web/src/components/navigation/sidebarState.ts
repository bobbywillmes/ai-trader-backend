export const SIDEBAR_PINNED_STORAGE_KEY = "ai-trader.sidebar.pinned";

export type SidebarState =
  | "desktop-collapsed"
  | "desktop-hover-expanded"
  | "desktop-pinned"
  | "mobile-open";

export type SidebarEvent =
  | "temporary-open"
  | "temporary-close"
  | "pin"
  | "unpin"
  | "mobile-open"
  | "mobile-close";

export function getInitialSidebarState(storage: Pick<Storage, "getItem"> | null): SidebarState {
  return storage?.getItem(SIDEBAR_PINNED_STORAGE_KEY) === "true"
    ? "desktop-pinned"
    : "desktop-collapsed";
}

export function contentOffsetFor(state: SidebarState) {
  if (state === "mobile-open") return 0;
  return state === "desktop-pinned" ? 248 : 72;
}

export function transitionSidebar(state: SidebarState, event: SidebarEvent, pinnedPreference = false): SidebarState {
  if (event === "pin") return "desktop-pinned";
  if (event === "unpin") return "desktop-collapsed";
  if (event === "mobile-open") return "mobile-open";
  if (event === "mobile-close") return pinnedPreference ? "desktop-pinned" : "desktop-collapsed";
  if (event === "temporary-open") return state === "desktop-pinned" ? state : "desktop-hover-expanded";
  if (event === "temporary-close") return state === "desktop-hover-expanded" ? "desktop-collapsed" : state;
  return state;
}
