# Web console responsive design

The web UI is a dense operational console. Responsive behavior must preserve evidence, account identity, safety context, and consequential actions rather than hiding fields to make narrow layouts fit.

## Shared layout contract

The application shell, page headers, filters, actions, tables, record details, and charts respond to their available container. Components must not assume a fixed viewport width or rely on page-level overflow suppression. Navigation and content remain usable with the sidebar expanded or pinned and at short mobile viewport heights.

Wide layouts normally use semantic tables. Intermediate layouts may use compact expandable records. Narrow layouts use labeled record cards and a details drawer when the full record would overwhelm the primary surface. Every presentation must retain stable record identity, material status, account/environment context, and access to all operational fields.

The shared primitives under `apps/web/src/components/data-display/` own these patterns. The development-only `/dev/responsive-data-primitives` route demonstrates the supported states in development builds using static fixtures.

## Details and actions

Expanded rows and drawers expose the same authoritative data; they do not independently recompute lifecycle, financial, readiness, or health values. Drawer close returns focus to its opener. Loading, empty, unavailable, and error states remain explicit at every width.

Consequential actions stay visually distinct from navigation and read-only inspection. Reconciliation preserves the difference between a dry broker read and a persisted run that may create System Events or exit-attention state. Lifecycle exercises continue to expose PAPER/LIVE context, confirmation, recovery, and diagnostic actions without compressing away safety language.

## Filters, routes, and reports

URL-owned filters, page sections, pagination, and account scope remain URL-authoritative on narrow layouts. Controls may change presentation, such as tabs becoming a labeled selector, but must retain browser back/forward behavior and unrelated query parameters.

Historical and report views may change tables into labeled records, but must not drop backend-provided fields or introduce client-only exports or calculations that diverge from canonical API filters and summaries. Charts require explicit responsive height, shared axes where appropriate, textual summaries, and non-color distinctions such as labels or dash patterns.

## Accessibility

- Interactive targets should be at least 44 pixels high where the compact operational layout permits.
- Status must be conveyed with text as well as color.
- Tabs, selectors, expanded state, dialogs, and drawers must expose their state to assistive technology.
- Long identifiers and diagnostic values wrap without forcing page overflow.
- Keyboard focus must remain visible and return predictably after dialogs and drawers close.
- Mobile layouts must retain labels for controls and fields rather than depending on position alone.

Current components and their tests are the implementation authority. This document defines reusable constraints, not a frozen page-by-page screenshot of the console.
