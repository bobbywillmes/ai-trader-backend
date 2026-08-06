# Responsive reconciliation

Reconciliation remains a run-scoped compatibility workspace for the configured default account. It does not invent persisted candidates, repair eligibility, filters, or health state beyond the existing `/api/reconciliation/run` response.

The result summary reports the returned run mode, findings, critical findings, created events, attention updates, and skipped duplicate events. Wide containers use a semantic findings table with inline details, compact containers use expandable rows, and narrow containers use cards with a focus-managed details drawer. Long messages, identifiers, and JSON evidence wrap within collapsed diagnostics.

Dry check remains explicitly non-mutating. Persisted reconciliation is separated from routine controls and uses a keyboard-accessible confirmation dialog before sending the unchanged `persistEvents: true` payload. Pending-state guards prevent duplicate submissions; backend locking, revalidation, ambiguity handling, refusal behavior, and attention safety remain authoritative and unchanged.
