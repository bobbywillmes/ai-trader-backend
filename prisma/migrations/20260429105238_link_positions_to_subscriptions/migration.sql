-- AlterTable
ALTER TABLE "TrackedPosition" ADD COLUMN     "subscriptionId" INTEGER;

-- AddForeignKey
ALTER TABLE "TrackedPosition" ADD CONSTRAINT "TrackedPosition_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
