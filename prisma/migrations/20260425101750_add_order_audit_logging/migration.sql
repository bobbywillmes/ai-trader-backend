-- CreateTable
CREATE TABLE "OrderIntent" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "timeInForce" TEXT NOT NULL,
    "qty" DOUBLE PRECISION,
    "notional" DOUBLE PRECISION,
    "limitPrice" DOUBLE PRECISION,
    "extendedHours" BOOLEAN NOT NULL DEFAULT false,
    "clientOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "blockReason" TEXT,
    "rawRequestJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerOrder" (
    "id" SERIAL NOT NULL,
    "orderIntentId" INTEGER NOT NULL,
    "broker" TEXT NOT NULL,
    "brokerOrderId" TEXT NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rawBrokerJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerOrder_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BrokerOrder" ADD CONSTRAINT "BrokerOrder_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
