/*
  Data-preserving user access model refactor.

  This migration intentionally renames the existing tables, columns, constraints,
  indexes, and sequences in place. It preserves users, sessions, setup tokens,
  trading-account assignments, and primary keys.
*/

BEGIN;

-- Create the new platform-scoped role enum.
CREATE TYPE "PlatformRole" AS ENUM ('SYSTEM_OWNER', 'OPERATOR', 'ACCOUNT_USER');

-- Fail loudly if a database contains a legacy role value that has not been mapped.
DO $$
DECLARE
  unexpected_roles TEXT;
BEGIN
  SELECT string_agg(role_value, ', ' ORDER BY role_value)
  INTO unexpected_roles
  FROM (
    SELECT DISTINCT "role" AS role_value
    FROM "AdminUser"
    WHERE "role" NOT IN ('owner', 'admin', 'account_manager', 'account_viewer')
  ) AS roles;

  IF unexpected_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot migrate AdminUser.role. Unexpected role values: %',
      unexpected_roles;
  END IF;
END $$;

-- Rename the identity and account-access tables in place.
ALTER TABLE "AdminUser" RENAME TO "User";
ALTER TABLE "AdminSession" RENAME TO "UserSession";
ALTER TABLE "AdminUserSetupToken" RENAME TO "UserSetupToken";
ALTER TABLE "TradingAccountAccess" RENAME TO "TradingAccountMembership";

-- Keep serial-sequence names aligned with the renamed Prisma models.
ALTER SEQUENCE "AdminUser_id_seq" RENAME TO "User_id_seq";
ALTER SEQUENCE "AdminSession_id_seq" RENAME TO "UserSession_id_seq";
ALTER SEQUENCE "AdminUserSetupToken_id_seq" RENAME TO "UserSetupToken_id_seq";
ALTER SEQUENCE "TradingAccountAccess_id_seq" RENAME TO "TradingAccountMembership_id_seq";

-- Rename user-related columns.
ALTER TABLE "User" RENAME COLUMN "role" TO "platformRole";
ALTER TABLE "User" RENAME COLUMN "invitedByAdminUserId" TO "invitedByUserId";
ALTER TABLE "UserSession" RENAME COLUMN "adminUserId" TO "userId";
ALTER TABLE "UserSetupToken" RENAME COLUMN "adminUserId" TO "userId";
ALTER TABLE "TradingAccount" RENAME COLUMN "ownerAdminUserId" TO "accountHolderUserId";
ALTER TABLE "TradingAccountMembership" RENAME COLUMN "adminUserId" TO "userId";

-- Convert legacy string roles to the new PlatformRole enum.
ALTER TABLE "User"
  ALTER COLUMN "platformRole" DROP DEFAULT;

ALTER TABLE "User"
  ALTER COLUMN "platformRole" TYPE "PlatformRole"
  USING (
    CASE "platformRole"
      WHEN 'owner' THEN 'SYSTEM_OWNER'::"PlatformRole"
      WHEN 'admin' THEN 'SYSTEM_OWNER'::"PlatformRole"
      WHEN 'account_manager' THEN 'OPERATOR'::"PlatformRole"
      WHEN 'account_viewer' THEN 'ACCOUNT_USER'::"PlatformRole"
    END
  );

ALTER TABLE "User"
  ALTER COLUMN "platformRole" SET DEFAULT 'ACCOUNT_USER'::"PlatformRole";

-- Rename primary-key and foreign-key constraints.
ALTER TABLE "User"
  RENAME CONSTRAINT "AdminUser_pkey" TO "User_pkey";
ALTER TABLE "User"
  RENAME CONSTRAINT "AdminUser_invitedByAdminUserId_fkey" TO "User_invitedByUserId_fkey";

ALTER TABLE "UserSession"
  RENAME CONSTRAINT "AdminSession_pkey" TO "UserSession_pkey";
ALTER TABLE "UserSession"
  RENAME CONSTRAINT "AdminSession_adminUserId_fkey" TO "UserSession_userId_fkey";

ALTER TABLE "UserSetupToken"
  RENAME CONSTRAINT "AdminUserSetupToken_pkey" TO "UserSetupToken_pkey";
ALTER TABLE "UserSetupToken"
  RENAME CONSTRAINT "AdminUserSetupToken_adminUserId_fkey" TO "UserSetupToken_userId_fkey";

ALTER TABLE "TradingAccount"
  RENAME CONSTRAINT "TradingAccount_ownerAdminUserId_fkey" TO "TradingAccount_accountHolderUserId_fkey";

ALTER TABLE "TradingAccountMembership"
  RENAME CONSTRAINT "TradingAccountAccess_pkey" TO "TradingAccountMembership_pkey";
ALTER TABLE "TradingAccountMembership"
  RENAME CONSTRAINT "TradingAccountAccess_adminUserId_fkey" TO "TradingAccountMembership_userId_fkey";
ALTER TABLE "TradingAccountMembership"
  RENAME CONSTRAINT "TradingAccountAccess_tradingAccountId_fkey" TO "TradingAccountMembership_tradingAccountId_fkey";

-- Rename retained unique indexes and lookup indexes.
ALTER INDEX "AdminUser_email_key" RENAME TO "User_email_key";

ALTER INDEX "AdminSession_tokenHash_key" RENAME TO "UserSession_tokenHash_key";
ALTER INDEX "AdminSession_adminUserId_idx" RENAME TO "UserSession_userId_idx";
ALTER INDEX "AdminSession_expiresAt_idx" RENAME TO "UserSession_expiresAt_idx";
ALTER INDEX "AdminSession_revokedAt_idx" RENAME TO "UserSession_revokedAt_idx";

ALTER INDEX "AdminUserSetupToken_tokenHash_key" RENAME TO "UserSetupToken_tokenHash_key";
ALTER INDEX "AdminUserSetupToken_adminUserId_idx" RENAME TO "UserSetupToken_userId_idx";
ALTER INDEX "AdminUserSetupToken_expiresAt_idx" RENAME TO "UserSetupToken_expiresAt_idx";
ALTER INDEX "AdminUserSetupToken_usedAt_idx" RENAME TO "UserSetupToken_usedAt_idx";
ALTER INDEX "AdminUserSetupToken_revokedAt_idx" RENAME TO "UserSetupToken_revokedAt_idx";

ALTER INDEX "TradingAccount_ownerAdminUserId_idx" RENAME TO "TradingAccount_accountHolderUserId_idx";

ALTER INDEX "TradingAccountAccess_adminUserId_idx"
  RENAME TO "TradingAccountMembership_userId_idx";
ALTER INDEX "TradingAccountAccess_tradingAccountId_adminUserId_key"
  RENAME TO "TradingAccountMembership_tradingAccountId_userId_key";

-- The composite unique index begins with tradingAccountId, so the former
-- standalone account index is no longer needed. The role index is obsolete.
DROP INDEX "TradingAccountAccess_tradingAccountId_idx";
DROP INDEX "TradingAccountAccess_role_idx";

-- Membership now represents account scope only. Platform role and application
-- permissions determine capabilities.
ALTER TABLE "TradingAccountMembership"
  DROP COLUMN "role",
  DROP COLUMN "canView",
  DROP COLUMN "canPauseTrading",
  DROP COLUMN "canResumeTrading",
  DROP COLUMN "canEditRiskSettings",
  DROP COLUMN "canEditStrategySettings",
  DROP COLUMN "canEditCredentials",
  DROP COLUMN "canManageAccess";

-- Ensure each account holder is also explicitly assigned to their account.
INSERT INTO "TradingAccountMembership" (
  "tradingAccountId",
  "userId",
  "createdAt",
  "updatedAt"
)
SELECT
  account."id",
  account."accountHolderUserId",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "TradingAccount" AS account
ON CONFLICT ("tradingAccountId", "userId") DO NOTHING;

-- No column uses the old account-level role enum anymore.
DROP TYPE "TradingAccountAccessRole";

COMMIT;
