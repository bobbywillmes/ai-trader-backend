# Owned Security universes: import, export, and Breadth revision

The production database is canonical. CSV files are reviewed instructions or snapshots; they do not grant trading authority. This setup does not import real constituents or Tiingo bars.

## Sparse CSV contract

The only required header is `symbol`. Optional columns are `name`, `sector`, `industry`, `SP500`, `NASDAQ100`, `DJIA`, `RUSSELL2000`, `SP400`, and `SP600`, in any order. Unknown or duplicate headers, duplicate normalized symbols, and malformed rows are rejected. Symbols are trimmed and uppercased; punctuation is preserved. Quote CSV fields containing commas or quotes.

Omitted columns remain untouched. Blank metadata and blank partial membership cells are no-ops. Nonblank metadata updates only supplied Securities. Import never accepts `enabled`, `assetType`, IDs, timestamps, subscriptions, strategies, or allocations. New Securities require a nonblank name and at least one explicit membership `1`; they are created as `STOCK` with `enabled=false`. Existing non-STOCK identities fail closed.

`partial` is the default. It touches only supplied Securities: membership `1` ensures active membership, `0` ends an active membership, and blank leaves it unchanged. `snapshot` is explicit reconciliation. Every supplied row needs `0` or `1` in each included membership column. Each included universe is complete: a Security omitted from the CSV is removed from that universe. Universes omitted from the header remain untouched. Metadata never uses snapshot removal semantics.

Stable source codes are `SP500` (S&P 500), `NASDAQ100` (Nasdaq-100), `DJIA` (Dow Jones Industrial Average), `RUSSELL2000` (Russell 2000), `SP400` (S&P MidCap 400), and `SP600` (S&P SmallCap 600). Conflicting source display names are rejected.

## Operator workflow

Use `/securities/import-export` or the CLI. Both call the same preview and transactional apply service. Choose an effective date and review additions, removals, metadata changes, broad population, per-universe counts, and conflicts before apply. Apply recomputes the plan under an advisory lock. No import automatically freezes a Breadth revision. A metadata-only import does not need one.

```powershell
npm.cmd run universe:import -- --file=reviewed.csv --effective=2026-10-01
npm.cmd run universe:import -- --file=reviewed.csv --effective=2026-10-01 --apply
# Complete quarterly reconciliation requires explicit snapshot mode:
npm.cmd run universe:import -- --file=reviewed.csv --effective=2026-10-01 --mode=snapshot
npm.cmd run universe:import -- --file=reviewed.csv --effective=2026-10-01 --mode=snapshot --apply
npm.cmd run universe:freeze -- --effective=2026-10-01
npm.cmd run universe:freeze -- --effective=2026-10-01 --apply
```

The page downloads a Universe Snapshot with exact re-importable columns `symbol,name,sector,industry,SP500,NASDAQ100,DJIA,RUSSELL2000,SP400,SP600` and a separate read-only Security Catalog with `id,symbol,name,enabled,assetType,sector,industry,createdAt,updatedAt`. Both are sorted by symbol. The Universe Snapshot includes only Securities with an active membership in at least one owned universe on the export date; the Security Catalog includes every Security. Catalog export fields do not gain import authority. Each download uses a UTC millisecond timestamp in its filename. A Google Sheet PRODUCTION benchmark may use the Universe Snapshot, but database state remains authoritative.

Membership intervals use `[effectiveFrom,effectiveTo)`. The importer preserves closed history, rejects same-day removal and future conflicts, and refuses membership changes that would alter an immutable frozen Breadth revision. Reapplication of the same file and date is idempotent. Freeze deduplicates one vote per Security and verifies its immutable member rows. `Security.enabled` is trading eligibility only and never filters observation membership. Import/freeze never creates Subscriptions, Strategies, allocations, orders, or other trading relationships.

No real constituent file is included or imported in Phase 3. The owner must prepare and review the actual source spreadsheet before first production import. Persistent Tiingo OHLCV remains separately gated on retention rights before Phase 4.
