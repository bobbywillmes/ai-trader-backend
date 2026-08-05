# Responsive Historical And Reporting Pages

Market Diary, System Events, Reports, and Trade History use container-responsive presentation so sidebar state and embedded layouts influence records independently of the viewport.

## Historical records

Wide containers use concise semantic tables. Compact containers use expandable summary rows, and narrow containers use record cards with stable identity and a consistent Details or lifecycle action. Date/time, account, symbol, record state, and the most important outcome remain in summaries; long notes and secondary fields move into structured detail sections.

Market Diary remains a read-only view of the current market-state record and recent diary-event endpoint. Its search and event-type filter operate on the returned 25-record window. Trade History date, status, mode, symbol, and limit controls continue to use the canonical trade-cycle query contract.

## Diagnostic details and raw metadata

System Event names are humanized for display without changing their stored type. The API does not currently return a severity or source field, so the page does not manufacture those values. Processing state, trading-account context, entity links, and timestamps remain explicit.

Payloads, internal IDs, raw event types, and routing keys are collapsed by default. Technical values wrap at arbitrary boundaries inside their detail container and must never determine page width. Drawers trap focus, close with Escape, and return focus to their opener.

## Reports and charts

Report controls wrap deliberately and become a single-column action/control stack on narrow containers. Overview, Trade Performance, and Audit Records are separated into keyboard-accessible tabs so each reporting task has a focused workspace. Existing Recharts responsive containers remain authoritative for sizing and preserve the backend-provided data, tooltip values, and calculations. Dense desktop tables retain semantic markup and become labeled record-card rows below laptop widths without dropping report fields.

Reports currently expose snapshot recording and broker-fill synchronization, but no export API or UI contract. Responsive work must not add a client-only export that could diverge from authoritative filters or report calculations.

## Trade results

Trade result summaries use canonical realized P/L and return values. Positive values include a plus sign; negative values retain their minus sign; zero and missing values have distinct text. Gain, loss, and break-even labels ensure meaning is not conveyed by color alone. Complete order, broker-activity, system-event, and lifecycle data remains available through the existing trade-cycle drawer.

## Mobile filters and states

The most-used search field remains visible while secondary controls move into the shared bottom filter drawer. Active filters are summarized with removable labels and Clear all. Refresh stays outside the drawer. Pages use shared loading, initial-empty, filtered-empty, recoverable-error, and retry treatments.

At 390–433 px, controls and action footers stack, use touch-sized buttons, and keep content within the page container. Do not solve local overflow by adding global `overflow-x: hidden`.
