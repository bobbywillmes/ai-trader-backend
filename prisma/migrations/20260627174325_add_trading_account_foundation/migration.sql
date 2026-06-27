-- CreateEnum
CREATE TYPE "TradingBroker" AS ENUM ('ALPACA');

-- CreateEnum
CREATE TYPE "TradingAccountEnvironment" AS ENUM ('PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "TradingAccountStatus" AS ENUM ('NEEDS_CREDENTIALS', 'ACTIVE', 'PAUSED', 'DISABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "BrokerCredentialAuthType" AS ENUM ('API_KEY', 'OAUTH');

-- CreateEnum
CREATE TYPE "BrokerCredentialStatus" AS ENUM ('NEEDS_VERIFICATION', 'ACTIVE', 'INVALID', 'REVOKED');

-- CreateEnum
CREATE TYPE "TradingAccountAccessRole" AS ENUM ('OWNER', 'MANAGER', 'VIEWER');

-- AlterTable
ALTER TABLE "AccountSnapshot" ADD COLUMN     "tradingAccountId" INTEGER;

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "AlpacaApiUsageBucket" ADD COLUMN     "tradingAccountId" INTEGER;

-- AlterTable
ALTER TABLE "BrokerActivity" ADD COLUMN     "tradingAccountId" INTEGER;

-- AlterTable
ALTER TABLE "BrokerOrder" ADD COLUMN     "tradingAccountId" INTEGER;

-- AlterTable
ALTER TABLE "EntryDecision" ADD COLUMN     "tradingAccountId" INTEGER;

-- AlterTable
ALTER TABLE "OrderIntent" ADD COLUMN     "tradingAccountId" INTEGER;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "tradingAccountId" INTEGER;

-- AlterTable
ALTER TABLE "SystemEvent" ADD COLUMN     "tradingAccountId" INTEGER;

-- AlterTable
ALTER TABLE "TrackedPosition" ADD COLUMN     "tradingAccountId" INTEGER;

-- CreateTable
CREATE TABLE "TradingAccount" (
    "id" SERIAL NOT NULL,
    "ownerAdminUserId" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "broker" "TradingBroker" NOT NULL DEFAULT 'ALPACA',
    "environment" "TradingAccountEnvironment" NOT NULL DEFAULT 'PAPER',
    "status" "TradingAccountStatus" NOT NULL DEFAULT 'NEEDS_CREDENTIALS',
    "tradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "killSwitchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "estimatedTradingCapital" DOUBLE PRECISION,
    "baseCurrency" TEXT NOT NULL DEFAULT 'USD',
    "brokerAccountId" TEXT,
    "brokerAccountNumberMasked" TEXT,
    "brokerAccountStatus" TEXT,
    "lastBrokerSyncAt" TIMESTAMP(3),
    "lastCash" DOUBLE PRECISION,
    "lastBuyingPower" DOUBLE PRECISION,
    "lastEquity" DOUBLE PRECISION,
    "lastPortfolioValue" DOUBLE PRECISION,
    "tradingBlocked" BOOLEAN,
    "pausedReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingAccountCredential" (
    "id" SERIAL NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "authType" "BrokerCredentialAuthType" NOT NULL DEFAULT 'API_KEY',
    "status" "BrokerCredentialStatus" NOT NULL DEFAULT 'NEEDS_VERIFICATION',
    "apiKeyCiphertext" TEXT,
    "apiSecretCiphertext" TEXT,
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "keyFingerprint" TEXT,
    "encryptionVersion" INTEGER NOT NULL DEFAULT 1,
    "verifiedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingAccountCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingAccountAccess" (
    "id" SERIAL NOT NULL,
    "tradingAccountId" INTEGER NOT NULL,
    "adminUserId" INTEGER NOT NULL,
    "role" "TradingAccountAccessRole" NOT NULL,
    "canView" BOOLEAN NOT NULL DEFAULT true,
    "canPauseTrading" BOOLEAN NOT NULL DEFAULT false,
    "canResumeTrading" BOOLEAN NOT NULL DEFAULT false,
    "canEditRiskSettings" BOOLEAN NOT NULL DEFAULT false,
    "canEditStrategySettings" BOOLEAN NOT NULL DEFAULT false,
    "canEditCredentials" BOOLEAN NOT NULL DEFAULT false,
    "canManageAccess" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingAccountAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradingAccount_ownerAdminUserId_idx" ON "TradingAccount"("ownerAdminUserId");

-- CreateIndex
CREATE INDEX "TradingAccount_broker_environment_idx" ON "TradingAccount"("broker", "environment");

-- CreateIndex
CREATE INDEX "TradingAccount_status_idx" ON "TradingAccount"("status");

-- CreateIndex
CREATE INDEX "TradingAccount_tradingEnabled_idx" ON "TradingAccount"("tradingEnabled");

-- CreateIndex
CREATE INDEX "TradingAccount_killSwitchEnabled_idx" ON "TradingAccount"("killSwitchEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccount_broker_environment_brokerAccountId_key" ON "TradingAccount"("broker", "environment", "brokerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccountCredential_tradingAccountId_key" ON "TradingAccountCredential"("tradingAccountId");

-- CreateIndex
CREATE INDEX "TradingAccountCredential_status_idx" ON "TradingAccountCredential"("status");

-- CreateIndex
CREATE INDEX "TradingAccountAccess_adminUserId_idx" ON "TradingAccountAccess"("adminUserId");

-- CreateIndex
CREATE INDEX "TradingAccountAccess_tradingAccountId_idx" ON "TradingAccountAccess"("tradingAccountId");

-- CreateIndex
CREATE INDEX "TradingAccountAccess_role_idx" ON "TradingAccountAccess"("role");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccountAccess_tradingAccountId_adminUserId_key" ON "TradingAccountAccess"("tradingAccountId", "adminUserId");

-- CreateIndex
CREATE INDEX "AccountSnapshot_tradingAccountId_idx" ON "AccountSnapshot"("tradingAccountId");

-- CreateIndex
CREATE INDEX "AccountSnapshot_tradingAccountId_createdAt_idx" ON "AccountSnapshot"("tradingAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "AccountSnapshot_tradingAccountId_reason_idx" ON "AccountSnapshot"("tradingAccountId", "reason");

-- CreateIndex
CREATE INDEX "AlpacaApiUsageBucket_tradingAccountId_idx" ON "AlpacaApiUsageBucket"("tradingAccountId");

-- CreateIndex
CREATE INDEX "AlpacaApiUsageBucket_tradingAccountId_bucketStart_idx" ON "AlpacaApiUsageBucket"("tradingAccountId", "bucketStart");

-- CreateIndex
CREATE INDEX "AlpacaApiUsageBucket_tradingAccountId_updatedAt_idx" ON "AlpacaApiUsageBucket"("tradingAccountId", "updatedAt");

-- CreateIndex
CREATE INDEX "BrokerActivity_tradingAccountId_idx" ON "BrokerActivity"("tradingAccountId");

-- CreateIndex
CREATE INDEX "BrokerActivity_tradingAccountId_transactionTime_idx" ON "BrokerActivity"("tradingAccountId", "transactionTime");

-- CreateIndex
CREATE INDEX "BrokerActivity_tradingAccountId_symbol_idx" ON "BrokerActivity"("tradingAccountId", "symbol");

-- CreateIndex
CREATE INDEX "BrokerOrder_tradingAccountId_idx" ON "BrokerOrder"("tradingAccountId");

-- CreateIndex
CREATE INDEX "BrokerOrder_tradingAccountId_status_idx" ON "BrokerOrder"("tradingAccountId", "status");

-- CreateIndex
CREATE INDEX "BrokerOrder_tradingAccountId_symbol_idx" ON "BrokerOrder"("tradingAccountId", "symbol");

-- CreateIndex
CREATE INDEX "EntryDecision_tradingAccountId_idx" ON "EntryDecision"("tradingAccountId");

-- CreateIndex
CREATE INDEX "EntryDecision_tradingAccountId_evaluatedAt_idx" ON "EntryDecision"("tradingAccountId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "EntryDecision_tradingAccountId_symbol_evaluatedAt_idx" ON "EntryDecision"("tradingAccountId", "symbol", "evaluatedAt");

-- CreateIndex
CREATE INDEX "OrderIntent_tradingAccountId_idx" ON "OrderIntent"("tradingAccountId");

-- CreateIndex
CREATE INDEX "OrderIntent_tradingAccountId_status_idx" ON "OrderIntent"("tradingAccountId", "status");

-- CreateIndex
CREATE INDEX "OrderIntent_tradingAccountId_createdAt_idx" ON "OrderIntent"("tradingAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "Subscription_tradingAccountId_idx" ON "Subscription"("tradingAccountId");

-- CreateIndex
CREATE INDEX "Subscription_tradingAccountId_enabled_idx" ON "Subscription"("tradingAccountId", "enabled");

-- CreateIndex
CREATE INDEX "Subscription_tradingAccountId_symbol_idx" ON "Subscription"("tradingAccountId", "symbol");

-- CreateIndex
CREATE INDEX "SystemEvent_tradingAccountId_idx" ON "SystemEvent"("tradingAccountId");

-- CreateIndex
CREATE INDEX "SystemEvent_tradingAccountId_createdAt_idx" ON "SystemEvent"("tradingAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "TrackedPosition_tradingAccountId_idx" ON "TrackedPosition"("tradingAccountId");

-- CreateIndex
CREATE INDEX "TrackedPosition_tradingAccountId_status_idx" ON "TrackedPosition"("tradingAccountId", "status");

-- CreateIndex
CREATE INDEX "TrackedPosition_tradingAccountId_symbol_idx" ON "TrackedPosition"("tradingAccountId", "symbol");

-- CreateIndex
CREATE INDEX "TrackedPosition_tradingAccountId_symbol_status_idx" ON "TrackedPosition"("tradingAccountId", "symbol", "status");

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_ownerAdminUserId_fkey" FOREIGN KEY ("ownerAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccountCredential" ADD CONSTRAINT "TradingAccountCredential_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccountAccess" ADD CONSTRAINT "TradingAccountAccess_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccountAccess" ADD CONSTRAINT "TradingAccountAccess_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerOrder" ADD CONSTRAINT "BrokerOrder_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemEvent" ADD CONSTRAINT "SystemEvent_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlpacaApiUsageBucket" ADD CONSTRAINT "AlpacaApiUsageBucket_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryDecision" ADD CONSTRAINT "EntryDecision_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedPosition" ADD CONSTRAINT "TrackedPosition_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSnapshot" ADD CONSTRAINT "AccountSnapshot_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerActivity" ADD CONSTRAINT "BrokerActivity_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
