-- CreateEnum
CREATE TYPE "VcCredentialStatus" AS ENUM ('valid', 'suspended', 'revoked');

-- CreateEnum
CREATE TYPE "DemoPortalRole" AS ENUM ('student', 'registrar');

-- CreateTable
CREATE TABLE "VcStatusList" (
    "issuerName" TEXT NOT NULL,
    "listNumber" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastIat" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VcStatusList_pkey" PRIMARY KEY ("issuerName","listNumber")
);

-- CreateTable
CREATE TABLE "VcStatusIndex" (
    "issuerName" TEXT NOT NULL,
    "listNumber" INTEGER NOT NULL,
    "idx" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VcStatusIndex_pkey" PRIMARY KEY ("issuerName","listNumber","idx")
);

-- CreateTable
CREATE TABLE "VcIssuedCredential" (
    "id" TEXT NOT NULL,
    "issuerName" TEXT NOT NULL,
    "vct" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "statusListNumber" INTEGER NOT NULL,
    "statusIndex" INTEGER NOT NULL,
    "cnfThumbprint" TEXT NOT NULL,
    "status" "VcCredentialStatus" NOT NULL DEFAULT 'valid',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VcIssuedCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoPortalAccount" (
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "DemoPortalRole" NOT NULL,
    "issuerName" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoPortalAccount_pkey" PRIMARY KEY ("username")
);

-- CreateIndex
CREATE INDEX "VcIssuedCredential_issuerName_subjectRef_idx" ON "VcIssuedCredential"("issuerName", "subjectRef");

-- CreateIndex
CREATE UNIQUE INDEX "VcIssuedCredential_issuerName_statusListNumber_statusIndex_key" ON "VcIssuedCredential"("issuerName", "statusListNumber", "statusIndex");

