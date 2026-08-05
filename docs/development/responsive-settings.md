# Responsive Settings workspace

Settings remains available at `/settings`, with the active workspace section encoded in the `section` query parameter. System Status is the default; Global Trading Controls, Reconciliation & Integrity, and User Settings are linkable and restored by browser back/forward navigation. Larger containers use an accessible tab-style control, while narrow containers use a labeled section selector so navigation never wraps into multiple rows.

## Section boundaries

- **System Status** is primarily read-only. It groups existing health, readiness, market/trading, worker, integration, environment, and audit-freshness data and links to System Events. It does not recalculate health or duplicate the operational event workspace.
- **Global Trading Controls** contains the global automated-trading switch, kill switch, paper/live compatibility control, and entry-session policy. Existing confirmation modals, partial PATCH payloads, validation, and submission locks remain unchanged.
- **Reconciliation & Integrity** summarizes existing worker/readiness status, owns the current scheduled-reconciliation configuration, and links to the full Reconciliation workspace. Repair and discrepancy investigation remain on that operational page.
- **User Settings** currently contains administrator password management. This is server-backed account behavior. Settings does not currently expose persisted display, timezone, density, or browser-local preferences, and the redesign does not invent them.

Changing sections warns before discarding entry-session or reconciliation drafts. Section-scoped saves continue to submit only the fields owned by that section, so unrelated runtime configuration is preserved.

## Legacy global risk limits

Legacy global risk-limit editors are no longer visible in Settings. The frontend form state, validation, labels, and save action for those fields were removed. Account-owned limits remain in Trading Account Risk Health and Configuration.

This is a presentation removal, not a backend cleanup. The existing config API still accepts and returns `maxDailyEntryOrders`, `maxDailyEntryNotional`, `maxOpenPositions`, `maxTotalOpenNotional`, `maxSymbolOpenNotional`, and `maxSubscriptionOpenNotional`. Backend risk resolution still uses several values as compatibility fallbacks when account-owned settings are absent, and a legacy risk path still evaluates global limits. Consequently:

- no backend, validator, database, or runtime-enforcement code was changed;
- existing stored values remain intact;
- unrelated Settings saves use partial PATCH payloads and cannot reset hidden values;
- removal of the contract and runtime fallbacks requires a dedicated trading-safety branch with migration and production-data analysis.

## Responsive and accessibility behavior

The workspace is container-responsive and does not rely on page-level overflow suppression. Navigation targets are at least 44px tall, active state is announced through `aria-selected`, the mobile selector has a persistent label, status is expressed with text as well as color, and existing confirmation dialogs retain Mantine focus management. Cards and controls stack on narrow containers, long diagnostic values wrap, and section selection stays usable at short mobile viewport heights.
