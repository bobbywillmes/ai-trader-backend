# Responsive data-display primitives

The components in `apps/web/src/components/data-display/` are the shared foundation for converting AI Trader's data-heavy pages without fetching or maintaining separate records for desktop and mobile. Phase 2 adds the foundation and a development preview; it intentionally does not migrate an operational feature page.

## Components

- `ResponsiveDataView` observes its containing region and renders one wide, compact, or narrow presentation for the same record collection. Record IDs are retained on the view for diagnostics, and presentation state outside the renderer survives a mode change.
- `DataTable` provides a semantic Mantine table with compact or normal density. It does not add a large minimum width or page-level scrolling.
- `CompactRecordList` renders primary summary fields and an explicit, accessible inline Details expansion.
- `MobileRecordCard` renders one touch-friendly record card with strong identity, status, metadata, details, and action regions.
- `RecordDetailsGrid` renders grouped semantic definition lists. Missing values use `Not available` by default and long technical values wrap.
- `ResponsiveDetails` provides inline content when requested or a focus-trapped, Escape-closeable side drawer. Drawer callers supply the opening element so focus can return on close.
- `ResponsiveFilterToolbar` keeps its primary control visible, wraps secondary filters, and exposes those filters in a bottom drawer at narrow container widths. Active filters and Clear all remain visible.
- `ResponsiveActions` keeps a primary action visible and moves secondary actions to an accessible menu. Destructive confirmation remains the page's responsibility so existing confirmation behavior is preserved.
- `DataState` provides announced loading, explanatory empty, and recoverable error states with optional retry.
- `StatusBadge` formats known enum-like states, assigns a semantic tone, and enforces intrinsic sizing. Supported labels never shrink or use ellipsis.

## Width and container strategy

`responsiveDataTokens.css` centralizes the key dimensions. Narrow is below 640px, compact is 640–1099px, and wide begins at 1100px. `ResponsiveDataView` establishes `container-type: inline-size`, so pinning or collapsing the application sidebar can change the presentation even when the viewport does not change.

The view uses `ResizeObserver` to mount only one presentation at a time. This avoids duplicate interactive trees and keeps a single detail/selection state in the page. Internal grids and summaries use CSS container queries. Media-query fallbacks cover browsers without container-query support; viewport queries remain appropriate for shell and full-screen/mobile overlay behavior.

## Building a record page

1. Fetch the collection once and keep filters, selected ID, expanded ID, and drawer opener in the page.
2. Pass the collection and a stable `getRecordId` to `ResponsiveDataView`.
3. Render semantic `DataTable` rows for wide mode, `CompactRecordList` summaries for compact mode, and `MobileRecordCard` records for narrow mode.
4. Reuse one details renderer built from `RecordDetailsGrid` for inline and drawer presentations.
5. Put the record identity and current operational state in primary content. Put configuration, routing, prices, timestamps, and diagnostic reasons in secondary details. Link to an existing lifecycle/account/raw diagnostic page for deep detail.
6. Use `DataState` before rendering the collection, and use `ResponsiveFilterToolbar` and `ResponsiveActions` around it as needed.

Primary fields should answer “what is this?” and “what is happening?” without opening details. A long subscription key, broker/client order ID, raw strategy key, or full internal reason is secondary. Human-readable summaries can truncate only when the complete value remains available in details.

## Status mapping

Use `StatusBadge` with a raw status and one of `positive`, `warning`, `danger`, `informational`, or `neutral`. Add concise known labels to `statusLabels` in `StatusBadge.tsx`; otherwise the formatter converts underscores to sentence case. Do not put long reasons in a badge. If the complete concise label does not fit, change the surrounding layout.

## Development preview

In a development build, authenticated admin users can open `/dev/responsive-data-primitives`. It is not included in navigation and uses static fixtures only. The route demonstrates all presentations, inline and drawer details, filters, actions, all data states, missing values, long values, P/L variants, and badge tones.

The route definition is guarded by `import.meta.env.DEV`, so production builds do not include a reachable route or lazily loaded preview chunk. Validate it while resizing the browser and with the sidebar both collapsed and pinned. Useful widths are 390, 402, 768, 1024, 1280, 1600, 1920, 2560, and 3840px; also check a 790px viewport height.

## Reference operational page

Open Positions is the first production page built on these primitives and is the reference for later operational conversions. Its primary summary keeps identity, account, side and quantity, current price, combined dollar/percentage P/L, position status, concise exit state, details, and safe action access visible. Entry pricing, full exit configuration, trailing values, routing identifiers, timestamps, and complete attention text are secondary details.

At wide container widths the page uses a concise semantic table with inline detail rows. Compact widths use summary records with the same vertical inline expansion; the identity remains visible while details are open. Narrow widths use scan-friendly cards and a focus-managed drawer. All modes organize operational details into Position and emphasized Exit management cards, keep routing identifiers in a collapsed disclosure, and separate actions into a footer. `ResponsiveActions` keeps lifecycle access explicit and places the destructive confirmed close action in an overflow menu. Future operational pages should use the same primary/secondary/deep-detail hierarchy rather than carrying every legacy column into their summary.

`DataTable` captions remain the accessible table name. Set `captionHidden` when a visible bottom caption would add visual noise; this hides it visually without removing it from the accessibility tree.

`CompactRecordList` also supports an optional generic action slot beside its details control. Use it when a compact operational record needs safe action access without making the row itself interactive.

## Trading account sections

Trading Account detail uses URL-addressable sections for Overview, Positions, Orders, Subscriptions, Risk Health, Readiness, Activity, and Configuration. At mobile widths the horizontal tab list becomes a labeled section selector. Keep each section independently responsive to its content container so sidebar state does not create a page-level horizontal scrollbar.

Positions and Orders reuse the same responsive record views as their global operational pages. Account scope belongs in the query and surrounding heading; do not fork their table, compact-row, card, detail, status, or action compositions. This keeps lifecycle actions, complete labels, empty/error/loading behavior, and primary-versus-secondary field decisions consistent.

Overview is concise and read-oriented. It owns account identity, broker snapshot, latest readiness and allocation summaries, safe credential status, and safety notes. It links to the authoritative detail sections instead of duplicating readiness history or editors. Configuration owns mutable safety/status controls, allocation bucket creation and editing, credential management, and immutable technical metadata. Do not repeat credential or trading controls as large editable Overview sections.

Account Subscriptions and Allocation Buckets follow the standard three-presentation system:

1. Wide containers use concise semantic `DataTable` summaries with inline details.
2. Compact containers use `CompactRecordList` with structured inline expansion.
3. Narrow containers use `MobileRecordCard` and a focus-managed `ResponsiveDetails` drawer.

Subscription summaries retain assignment identity, strategy, full enabled and entry-capability status, allocation, sizing, exit profile, details, and existing management actions. Allocation summaries retain name/key, full status, budget, reserved/remaining capacity, position limits, assignment counts, details, and Edit. Raw IDs, technical keys, timestamps, notes, and secondary limits belong in structured details and must wrap safely.

Future account sections should reuse `DataState`, `StatusBadge`, `ResponsiveActions`, and the same detail renderer across modes. An internal scroll region can remain for genuinely diagnostic historical data, but a legacy minimum-width table must never set the width of the account page. Preserve authorization, confirmations, disabled/loading states, and safety behavior when changing presentation.

## Dashboard command center

Dashboard is a concise responsive command center rather than a full operational record page. Its composition is portfolio state, trading readiness, ETF Market Pulse, limited open-position and open-order previews, and current attention items. Deep history remains on Reports, System Events, Reconciliation, and account detail routes.

Portfolio metrics use the broker account snapshot plus `risk.usage.totalOpenNotional`; Dashboard does not recompute financial values. Trading Readiness maps backend entry-session states to state-specific transitions and formats every market timestamp in `America/New_York`. Missing current-session timestamps after close must not be described as proof that no regular session occurred, and missing future timestamps remain explicitly unavailable.

Market Pulse uses the existing index quote and history requests. Each returned history series is normalized to 0% at its own first point and rendered against a shared time and percentage axis. The zero reference, textual summary, signed values, line dash patterns, and tile labels keep the display understandable without color. Quote tiles retain current, change, low, high, previous close, a sparkline, and a guarded range rail. The chart parent has an explicit responsive height and no fixed width so pinned-sidebar changes cannot create page overflow.

Dashboard record previews show at most four positions and four orders and always link to their full operational pages. Attention items are restricted to current bootstrap facts such as broker blocking, risk reasons, or a degraded market-session provider. Historical event severity is not treated as unresolved state. When those authoritative facts are healthy, Dashboard provides links to System Events and Reconciliation instead of manufacturing alerts.
