-- Restrict the durable ownership vocabulary and make release terminal at the
-- database boundary. Lifecycle edge validation remains in the service because
-- PostgreSQL CHECK constraints cannot compare OLD and NEW rows.
ALTER TABLE "EntryExposureClaim"
  ADD CONSTRAINT "EntryExposureClaim_status_check" CHECK (
    "status" IN (
      'ENTRY_PENDING', 'ENTRY_SUBMITTING', 'BROKER_ORDER_ACTIVE',
      'PARTIALLY_FILLED', 'FILLED_AWAITING_POSITION', 'POSITION_OPEN', 'POSITION_CLOSING',
      'ADMISSION_BLOCKED', 'UNRESOLVED', 'RELEASED'
    )
  );

ALTER TABLE "EntryExposureClaim"
  ADD CONSTRAINT "EntryExposureClaim_released_status_check" CHECK (
    ("releasedAt" IS NULL AND "status" <> 'RELEASED') OR
    ("releasedAt" IS NOT NULL AND "status" = 'RELEASED')
  );
