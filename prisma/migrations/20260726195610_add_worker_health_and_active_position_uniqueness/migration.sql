-- CreateIndex
CREATE INDEX "AccountSnapshot_runKey_idx"
ON "AccountSnapshot"("runKey");

-- CreateIndex
CREATE INDEX "AlpacaApiUsageBucket_bucketStart_operation_endpoint_method__idx"
ON "AlpacaApiUsageBucket"("bucketStart", "operation", "endpoint", "method", "requestClass");

-- CreateIndex
CREATE INDEX "BrokerActivity_activityId_idx"
ON "BrokerActivity"("activityId");

-- CreateIndex
CREATE INDEX "BrokerOrder_broker_brokerOrderId_idx"
ON "BrokerOrder"("broker", "brokerOrderId");

-- CreateIndex
CREATE INDEX "BrokerOrder_broker_clientOrderId_idx"
ON "BrokerOrder"("broker", "clientOrderId");
