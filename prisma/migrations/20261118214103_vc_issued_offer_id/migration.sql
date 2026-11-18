-- AlterTable
ALTER TABLE "VcIssuedCredential" ADD COLUMN     "offerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "VcIssuedCredential_offerId_key" ON "VcIssuedCredential"("offerId");

