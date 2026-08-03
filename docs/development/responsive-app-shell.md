# Responsive application shell

The web console uses `ResponsiveAppShell` for both the administration console and account portal. Its explicit states are `desktop-collapsed`, `desktop-hover-expanded`, `desktop-pinned`, and `mobile-open`.

At widths above Mantine's `sm` breakpoint (`48em`), the sidebar starts as a 72px icon rail. Pointer entry or keyboard focus temporarily expands it to 248px as an overlay without moving page content. Pinning changes the persistent page offset to 248px. The browser/device-specific preference is stored under `ai-trader.sidebar.pinned` in `localStorage`.

At and below `48em`, the desktop sidebar is removed and a 60px application header opens the full expanded navigation in a Mantine drawer sized to `min(320px, 88vw)`. Navigation and the fixed user footer share the same components in both layouts.

Navigation is configured in `apps/web/src/app/navigation.ts`. Add future links to the appropriate typed `AdminNavGroup`, supplying `label`, `to`, a Tabler `icon`, and any existing `requiredPermission` or `systemOwnerOnly` restriction. The default active matcher includes child routes; use `isActive` only when a destination needs more precise matching. Empty or inaccessible sections are removed by `filterNavigationGroups`.
