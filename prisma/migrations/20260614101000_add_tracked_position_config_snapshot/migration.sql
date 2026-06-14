-- Store an immutable copy of decision-critical configuration against each
-- tracked-position trade cycle. Nullable keeps existing historical rows valid.

ALTER TABLE "TrackedPosition"
ADD COLUMN "configSnapshotJson" JSONB,
ADD COLUMN "configSnapshotCapturedAt" TIMESTAMP(3);
