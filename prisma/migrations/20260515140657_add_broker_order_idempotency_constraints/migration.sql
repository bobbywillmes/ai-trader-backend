/*
  Warnings:

  - A unique constraint covering the columns `[broker,brokerOrderId]` on the table `BrokerOrder` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[broker,clientOrderId]` on the table `BrokerOrder` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "BrokerOrder_broker_brokerOrderId_key" ON "BrokerOrder"("broker", "brokerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerOrder_broker_clientOrderId_key" ON "BrokerOrder"("broker", "clientOrderId");
