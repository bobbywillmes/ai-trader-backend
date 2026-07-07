-- Add nullable onboarding metadata for invited admin users.
ALTER TABLE "AdminUser" ALTER COLUMN "passwordHash" DROP NOT NULL,
ALTER COLUMN "role" SET DEFAULT 'account_viewer',
ADD COLUMN "invitedAt" TIMESTAMP(3),
ADD COLUMN "invitedByAdminUserId" INTEGER,
ADD COLUMN "setupCompletedAt" TIMESTAMP(3);

-- Existing admin users already have credentials and should not be treated as pending setup.
UPDATE "AdminUser"
SET "setupCompletedAt" = "createdAt"
WHERE "setupCompletedAt" IS NULL;

-- Store one-time account setup tokens as hashes only.
CREATE TABLE "AdminUserSetupToken" (
    "id" SERIAL NOT NULL,
    "adminUserId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUserSetupToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminUserSetupToken_tokenHash_key" ON "AdminUserSetupToken"("tokenHash");
CREATE INDEX "AdminUserSetupToken_adminUserId_idx" ON "AdminUserSetupToken"("adminUserId");
CREATE INDEX "AdminUserSetupToken_expiresAt_idx" ON "AdminUserSetupToken"("expiresAt");
CREATE INDEX "AdminUserSetupToken_usedAt_idx" ON "AdminUserSetupToken"("usedAt");
CREATE INDEX "AdminUserSetupToken_revokedAt_idx" ON "AdminUserSetupToken"("revokedAt");

ALTER TABLE "AdminUserSetupToken" ADD CONSTRAINT "AdminUserSetupToken_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_invitedByAdminUserId_fkey" FOREIGN KEY ("invitedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
