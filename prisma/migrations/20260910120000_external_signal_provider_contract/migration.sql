-- Prior capability URLs cannot be recovered. Provision encrypted replacements
-- through the application after migration (or on first owner URL retrieval).
ALTER TABLE "ExternalSignalSource" RENAME COLUMN "webhookTokenHash" TO "webhookKeyHash";
ALTER INDEX "ExternalSignalSource_webhookTokenHash_key" RENAME TO "ExternalSignalSource_webhookKeyHash_key";
ALTER TABLE "ExternalSignalSource" ADD COLUMN "webhookKeyCiphertext" TEXT;
UPDATE "ExternalSignalSource" SET "webhookKeyHash" = 'invalidated:' || id::text;

-- Keep legacy keys and rejection enum values without inventing event identity.
ALTER TYPE "SignalDeliveryRejectionCode" ADD VALUE 'EVENT_FINGERPRINT_CONFLICT';
ALTER TABLE "Signal" ALTER COLUMN "externalEventKey" DROP NOT NULL;
ALTER TABLE "Signal" ADD COLUMN "eventFingerprint" TEXT;
CREATE UNIQUE INDEX "Signal_signalSourceId_eventFingerprint_key" ON "Signal"("signalSourceId", "eventFingerprint");
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_event_identity_check" CHECK (
  ("externalEventKey" IS NOT NULL AND "eventFingerprint" IS NULL) OR
  ("externalEventKey" IS NULL AND "eventFingerprint" IS NOT NULL));
