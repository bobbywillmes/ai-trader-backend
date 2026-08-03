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

## Next phase

Open Positions is the reference conversion for the next branch. That work should decide the final primary field hierarchy using real operator workflows, reuse existing lifecycle and close-position behavior, and tune widths/density against real records. Existing page tables and badges remain in place until their pages are deliberately migrated.
