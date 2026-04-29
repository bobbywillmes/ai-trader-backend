-- AlterTable
ALTER TABLE "OrderIntent" ADD COLUMN     "subscriptionId" INTEGER,
ADD COLUMN     "subscriptionKey" TEXT;

-- AddForeignKey
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
