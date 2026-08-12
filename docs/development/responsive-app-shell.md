# Responsive application shell

The web console uses `ResponsiveAppShell` for both the administration console and account portal. Its explicit states are `desktop-collapsed`, `desktop-hover-expanded`, `desktop-pinned`, and `mobile-open`.

At widths above Mantine's `sm` breakpoint (`48em`), the sidebar starts as a 72px icon rail. Pointer entry or keyboard focus temporarily expands it to 248px as an overlay without moving page content. Pinning changes the persistent page offset to 248px. The browser/device-specific preference is stored under `ai-trader.sidebar.pinned` in `localStorage`.

At and below `48em`, the desktop sidebar is removed and a 60px application header opens the full expanded navigation in a Mantine drawer sized to `min(320px, 88vw)`. Navigation and the fixed user footer share the same components in both layouts.

Navigation is configured in `apps/web/src/app/navigation.ts`, while role and permission policy lives in `apps/web/src/app/routeAccess.ts` and is shared with direct-route guards. Add future destinations with a `routeId`, `label`, `to`, and Tabler `icon`; use `labelByRole` for presentation-only naming differences such as Trading Accounts/My Accounts. The default active matcher includes child routes; use `isActive` only for more precise matching. Empty or inaccessible sections are removed by `filterNavigationGroups`.

The shell supports one level of expandable navigation. A parent is active and forced open whenever a child route is active; otherwise it may be expanded or collapsed manually. The same navigation component drives the expanded desktop sidebar and mobile drawer. The collapsed desktop icon rail expands through its existing pointer/focus behavior before exposing children. Do not introduce grandchildren.
