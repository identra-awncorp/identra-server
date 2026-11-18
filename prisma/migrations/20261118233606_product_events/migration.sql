-- CreateTable
CREATE TABLE "ProductEvent" (
    "id" TEXT NOT NULL,
    "gtin" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "congDoan" TEXT NOT NULL,
    "issuerName" TEXT NOT NULL,
    "compact" TEXT NOT NULL,
    "compactHash" TEXT NOT NULL,
    "statusListNumber" INTEGER NOT NULL,
    "statusIndex" INTEGER NOT NULL,
    "status" "VcCredentialStatus" NOT NULL DEFAULT 'valid',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductEvent_gtin_serial_seq_key" ON "ProductEvent"("gtin", "serial", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEvent_issuerName_statusListNumber_statusIndex_key" ON "ProductEvent"("issuerName", "statusListNumber", "statusIndex");

