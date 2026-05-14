-- CreateTable
CREATE TABLE "BrokerActivity" (
    "id" SERIAL NOT NULL,
    "broker" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "activityType" TEXT NOT NULL,
    "activityCategory" TEXT,
    "symbol" TEXT,
    "side" TEXT,
    "qty" DOUBLE PRECISION,
    "cumQty" DOUBLE PRECISION,
    "leavesQty" DOUBLE PRECISION,
    "price" DOUBLE PRECISION,
    "netAmount" DOUBLE PRECISION,
    "orderId" TEXT,
    "orderIntentId" INTEGER,
    "brokerOrderRecordId" INTEGER,
    "transactionTime" TIMESTAMP(3),
    "rawBrokerJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrokerActivity_activityId_key" ON "BrokerActivity"("activityId");

-- CreateIndex
CREATE INDEX "BrokerActivity_activityType_idx" ON "BrokerActivity"("activityType");

-- CreateIndex
CREATE INDEX "BrokerActivity_symbol_idx" ON "BrokerActivity"("symbol");

-- CreateIndex
CREATE INDEX "BrokerActivity_side_idx" ON "BrokerActivity"("side");

-- CreateIndex
CREATE INDEX "BrokerActivity_orderId_idx" ON "BrokerActivity"("orderId");

-- CreateIndex
CREATE INDEX "BrokerActivity_transactionTime_idx" ON "BrokerActivity"("transactionTime");

-- CreateIndex
CREATE INDEX "BrokerActivity_orderIntentId_idx" ON "BrokerActivity"("orderIntentId");

-- CreateIndex
CREATE INDEX "BrokerActivity_brokerOrderRecordId_idx" ON "BrokerActivity"("brokerOrderRecordId");

-- CreateIndex
CREATE INDEX "BrokerActivity_broker_mode_idx" ON "BrokerActivity"("broker", "mode");

-- AddForeignKey
ALTER TABLE "BrokerActivity" ADD CONSTRAINT "BrokerActivity_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerActivity" ADD CONSTRAINT "BrokerActivity_brokerOrderRecordId_fkey" FOREIGN KEY ("brokerOrderRecordId") REFERENCES "BrokerOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
