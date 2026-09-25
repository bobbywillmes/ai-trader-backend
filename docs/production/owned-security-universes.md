# Reviewed Security universe import and Breadth revision

AI Trader owns these observation universes. The input is an owner-reviewed, complete CSV snapshot exported from a spreadsheet, maintained manually about quarterly. It is not sourced from Tiingo's full ticker catalog, and these commands do not fetch constituents, bars, or other provider data. Import and freeze do not create trading relationships or BREADTH_V2 observations/assessments.

## CSV contract

The UTF-8 CSV header is exact and ordered:

```csv
symbol,name,sector,industry,SP500,NASDAQ100,DJIA,RUSSELL2000,SP400,SP600
AAPL,Apple Inc,Technology,Consumer Electronics,1,1,0,0,0,0
MSFT,Microsoft Corp,Technology,Software,1,1,0,0,0,0
IBM,International Business Machines,Technology,IT Services,0,0,1,0,0,0
```

One row represents one Security/issue. `symbol` is trimmed and uppercased exactly like the existing Securities catalog; punctuation is preserved (`BRK.B` remains `BRK.B`). `name` is required. Blank `sector`/`industry` means null; these are mutable current metadata, not classification history. The six source flags must each be `0` or `1`, and each row must have at least one `1`. Quote CSV fields containing commas or quotes. Duplicate symbols after catalog normalization, malformed rows, ambiguous existing Security identities, and existing non-STOCK identities are conflicts. Do not add empty rows to request removals: this is a complete snapshot, so omission from a source flag or the file ends an existing active membership.

Stable source codes and names are `SP500` (S&P 500), `NASDAQ100` (Nasdaq-100), `DJIA` (Dow Jones Industrial Average), `RUSSELL2000` (Russell 2000), `SP400` (S&P MidCap 400), and `SP600` (S&P SmallCap 600). An existing code with a different display name is rejected rather than silently renamed.

## Preview, apply, freeze

Use the same explicit effective date for a reviewed import and its initial Breadth revision. Keep the CSV and its preview report as operator review artifacts. Preview writes nothing; apply uses one transaction and an advisory lock.

```powershell
npm.cmd run universe:import -- --file=reviewed-constituents.csv --effective=2026-10-01
npm.cmd run universe:import -- --file=reviewed-constituents.csv --effective=2026-10-01 --apply
npm.cmd run universe:freeze -- --effective=2026-10-01
npm.cmd run universe:freeze -- --effective=2026-10-01 --apply
```

The import preview lists new and existing Securities, before/after name/sector/industry changes, membership additions, removals, unchanged membership count, missing source universe identities, conflicts, and the deduplicated broad count. It never changes `Security.enabled` on an existing row; new observation-only Securities are explicitly `enabled=false` and `assetType=STOCK`. It never creates a Subscription, Strategy, TradingAccountSubscription, TradingAccountAllocation, or other trading authority. Apply refuses any conflict and is idempotent for the same CSV/date.

Membership intervals use `[effectiveFrom, effectiveTo)`: a removal at date D sets the active row's `effectiveTo` to D; a later re-add creates a new row. Closed historical intervals are not rewritten. The importer refuses same-day removal of a just-added interval, scheduled future membership edits, and changes at or before an already frozen revision. It does not use `Security.enabled` to select observations.

Freeze computes active memberships across these six source codes on the effective date, deduplicates by Security ID, verifies all member Securities, and inserts the immutable revision and members atomically. The result reports `memberCount` and a SHA-256 constituent hash over the sorted uppercase symbols joined by newline with a final newline. The date is not part of the hash, so equal populations have equal hashes. The hash is reported, not persisted in the Phase 0/1 schema. Repeating a freeze for an identical existing revision is a no-op; a different population at the same date is rejected. Only run freeze after reviewing the import preview and applying the matching CSV.

## Quarterly maintenance and verification

Export a newly reviewed **complete** snapshot, choose its effective date, preview and inspect all removals and metadata changes, then apply and freeze. Never use a partial list: omission end-dates active source membership. Older frozen revisions remain immutable; end-dating later intervals does not alter membership at their earlier effective dates.

Check the active union independently with read-only SQL, replacing the date:

```sql
SELECT count(DISTINCT m."securityId") AS broad_member_count
FROM "SecurityUniverseMembership" m
JOIN "SecurityUniverse" u ON u.id=m."universeId"
WHERE u.code IN ('SP500','NASDAQ100','DJIA','RUSSELL2000','SP400','SP600')
  AND m."effectiveFrom" <= DATE '2026-10-01'
  AND (m."effectiveTo" IS NULL OR m."effectiveTo" > DATE '2026-10-01');

SELECT r.id, r."effectiveFrom", r."memberCount", count(m."securityId") AS persisted_members
FROM "BreadthUniverseRevision" r
JOIN "BreadthUniverseRevisionMember" m ON m."revisionId"=r.id
WHERE r."effectiveFrom"=DATE '2026-10-01'
GROUP BY r.id;
```

No real constituent file is included or imported by Phase 3. The owner must prepare and review the actual six-source spreadsheet before the first production import. Persistent Tiingo OHLCV remains separately gated on retention rights.
