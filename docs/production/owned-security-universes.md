# Owned Security universes: import, export, and Breadth revision

The production database is canonical. CSV files are reviewed change instructions or production-state references; they do not grant trading authority. This setup does not import real constituents or Tiingo bars.

## Sparse CSV contract

The only required header is `symbol`. Optional columns are `name`, `sector`, `industry`, `SP500`, `NASDAQ100`, `DJIA`, `RUSSELL2000`, `SP400`, and `SP600`, in any order. Unknown or duplicate headers, duplicate normalized symbols, and malformed rows are rejected. Symbols are trimmed and uppercased; punctuation is preserved. Quote CSV fields containing commas or quotes.

**Nothing changes unless the CSV explicitly supplies a nonblank value for that Security and field. Membership removal always requires an explicit `0`.** Omitted Security rows, omitted columns, and blank cells leave existing values untouched. A membership `1` ensures membership; `0` ends it or keeps it absent. Nonblank metadata updates only supplied Securities. Import never accepts `enabled`, `assetType`, IDs, timestamps, subscriptions, strategies, or allocations. New Securities require a nonblank name and at least one explicit membership `1`; they are created as `STOCK` with `enabled=false`. Existing non-STOCK identities fail closed.

Stable source codes are `SP500` (S&P 500), `NASDAQ100` (Nasdaq-100), `DJIA` (Dow Jones Industrial Average), `RUSSELL2000` (Russell 2000), `SP400` (S&P MidCap 400), and `SP600` (S&P SmallCap 600). Conflicting source display names are rejected.

## Operator workflow

Use `/securities/import-export` or the CLI. Both call the same preview and transactional apply service. Normal imports take effect immediately on the server's current `America/New_York` calendar date; the operator does not choose a date. Review additions, removals, metadata changes, broad population, per-universe counts, and conflicts before apply. Apply recomputes the plan under an advisory lock. No import automatically freezes a Breadth revision. A metadata-only import does not need one.

For announced future index changes, expand **Advanced options** and select **Schedule universe membership changes for a future date**. The date must be strictly after today's New York date. New Security records and nonblank name/sector/industry metadata are applied immediately; only owned-universe membership flags take effect on the selected date. Until then, the current universe and Universe Snapshot remain unchanged. This neither enables trading nor schedules trading actions. The page does not offer a Breadth freeze for future-effective imports. Historical repair is outside this normal operator workflow.

```powershell
npm.cmd run universe:import -- --file=reviewed.csv
npm.cmd run universe:import -- --file=reviewed.csv --apply
# Future membership scheduling (metadata and new Securities are applied now):
npm.cmd run universe:import -- --file=announced.csv --schedule=2026-10-01
npm.cmd run universe:import -- --file=announced.csv --schedule=2026-10-01 --apply
# Freeze is separate, only after an immediate membership-changing import:
npm.cmd run universe:freeze -- --effective=2026-09-27
npm.cmd run universe:freeze -- --effective=2026-09-27 --apply
```

The page downloads a Universe Snapshot with exact re-importable columns `symbol,name,sector,industry,SP500,NASDAQ100,DJIA,RUSSELL2000,SP400,SP600` and a separate read-only Security Catalog with `id,symbol,name,enabled,assetType,sector,industry,createdAt,updatedAt`. Both are sorted by symbol. The Universe Snapshot includes only Securities with an active membership in at least one owned universe on the export date; the Security Catalog includes every Security. Use the Universe Snapshot for production-state comparison and review; importing it changes only fields explicitly supplied in its rows and never removes omitted Securities. Catalog export fields do not gain import authority. Each download uses a UTC millisecond timestamp in its filename. A Google Sheet PRODUCTION benchmark may use the Universe Snapshot, but database state remains authoritative.

Membership intervals use `[effectiveFrom,effectiveTo)`. Same-day corrections converge to the final date-level truth: a just-added membership can be removed without leaving a zero-length interval, and a same-day end of an older membership can be reopened. Future conflicts and any change constrained by an immutable Breadth revision remain fail-closed. Reapplication of the same CSV is idempotent on the same resolved date. Freeze deduplicates one vote per Security and verifies its immutable member rows. `Security.enabled` is trading eligibility only and never filters observation membership. Import/freeze never creates Subscriptions, Strategies, allocations, orders, or other trading relationships.

No real constituent file is included or imported in Phase 3. The owner must prepare and review the actual source spreadsheet before first production import. Persistent Tiingo OHLCV remains separately gated on retention rights before Phase 4.
