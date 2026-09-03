# Historical lifecycle repair runbook

Use Operational Attention to open the owner-only Lifecycle Repair Workbench.
Never use SQL or operator-entered lifecycle values.

1. Create a preview and review stored OrderIntent, BrokerOrder, fill, candidate,
   predicate, timing, and price evidence.
2. Confirm broker impact, exposure impact, and financial-value impact are NONE.
3. Independently approve or refuse terminalization. Apply only on PAPER using
   the exact action confirmation.
4. Refresh. Terminalization must leave link-only attention active.
5. Independently approve or refuse the closed-position link. Treat displayed
   broker-average arithmetic only as non-authoritative corroboration.
6. Apply an approved PAPER link and run authoritative reconciliation.
7. Confirm attention resolves once and audit evidence remains available.

If links are partial or conflicting, stop: the Workbench must leave the episode
active and must not offer an applicable link mutation. Refusal also leaves the
episode active. Reconsideration requires a new reason and freshly rebuilt
evidence. `APPLIED` records a structurally valid local transaction; it is not
authoritative `VERIFIED` until reconciliation no longer observes the invariant.

For synthetic rehearsal use
`scripts/lifecycle-repair-acceptance/README.md`. The harness refuses every
database except `ai_trader_lifecycle_repair_acceptance` and installs the
fail-closed broker transport before application import.

Production rollout follows the normal backup, additive migration, restart, and
health-verification process. Roll application code back only after confirming
the additive audit tables remain; never destructively remove repair audit data
or rewrite historical SystemEvents.
