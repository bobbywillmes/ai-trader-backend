# Responsive reconciliation

Reconciliation is route-authoritative at `/trading-accounts/:id/reconciliation`. Both dry and persisted runs call `POST /api/trading-accounts/:id/reconciliation/run`; the path ID selects broker credentials, broker reads, local lifecycle records, SystemEvent attribution, and eligible exit-attention updates. The dormant `?account=` value is preserved for later operational navigation and never selects the reconciliation target.

The compatibility route `/system/reconciliation` redirects only when `?account=<id>` names an accessible TradingAccount. Missing scope and `?account=all` render a target chooser and never select the configured, first, paper, or otherwise inferred account.

The result summary reports the returned run mode, findings, critical findings, created events, attention updates, and skipped duplicate events. Wide containers use a semantic findings table with inline details, compact containers use expandable rows, and narrow containers use cards with a focus-managed details drawer. Long messages, identifiers, and JSON evidence wrap within collapsed diagnostics.

Dry check remains explicitly non-persisting and performs only broker reads. Persisted reconciliation is separated from routine controls and uses a keyboard-accessible confirmation dialog naming the TradingAccount and PAPER/LIVE environment before sending the unchanged `persistEvents: true` behavior. It may create local SystemEvents and mark qualifying local exit states as attention-required, but it does not place, cancel, or modify broker orders or positions. Missing credentials or failed broker observation are shown as unavailable and cannot produce a zero-discrepancy or completed persisted result.
