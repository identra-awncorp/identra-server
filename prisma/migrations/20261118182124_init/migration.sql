-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('VERIFIED', 'PENDING', 'EXPIRED', 'FAILED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('VERIFY', 'SHARE', 'ADD', 'SECURITY', 'SCAN', 'PAYMENT', 'CHAT');

-- CreateEnum
CREATE TYPE "ActivityStatus" AS ENUM ('SUCCESS', 'PENDING', 'FAILED');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'MEDIA', 'CREDENTIAL', 'CONTRACT', 'PAYMENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INCOMING', 'OUTGOING');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'READY', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNAVAILABLE', 'SOLD_OUT');

-- CreateEnum
CREATE TYPE "DemoScenarioStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('REGISTER', 'LOGIN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "did" TEXT,
    "fullName" TEXT NOT NULL,
    "dob" TEXT,
    "studentId" TEXT,
    "school" TEXT,
    "nationalId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "phoneVerifiedAt" TIMESTAMP(3),
    "address" TEXT,
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "platform" TEXT,
    "deviceName" TEXT,
    "appVersion" TEXT,
    "refreshTokenHash" TEXT,
    "trustedAt" TIMESTAMP(3),
    "trustRevokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpChallenge" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "userId" TEXT,
    "purpose" "OtpPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "passwordSetupTokenHash" TEXT,
    "passwordSetupExpiresAt" TIMESTAMP(3),
    "passwordSetAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "resendAvailableAt" TIMESTAMP(3) NOT NULL,
    "deviceId" TEXT,
    "platform" TEXT,
    "deviceName" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPassword" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordPepperVersion" TEXT,
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPassword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issuer" (
    "id" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "trustLevel" TEXT NOT NULL DEFAULT 'demo',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issuer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "holderId" TEXT NOT NULL,
    "issuerId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'PENDING',
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "claims" JSONB NOT NULL,
    "proof" JSONB,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialAttribute" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isSensitive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareRequest" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT,
    "requesterDid" TEXT,
    "verifierName" TEXT NOT NULL,
    "requestedClaims" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShareRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationRecord" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT,
    "verifierDid" TEXT,
    "verifierName" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "status" "ActivityStatus",
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "partner" TEXT NOT NULL,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "type" TEXT NOT NULL DEFAULT 'direct',
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT,
    "senderDisplayName" TEXT,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "direction" "MessageDirection" NOT NULL,
    "body" TEXT,
    "payload" JSONB,
    "deliveryStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedPost" (
    "id" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorName" TEXT NOT NULL,
    "handle" TEXT,
    "text" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'post',
    "payload" JSONB,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'in_app',
    "readAt" TIMESTAMP(3),
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MiniApp" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scopes" TEXT[],
    "launchUrl" TEXT,
    "metadata" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MiniApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoScenario" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "DemoScenarioStatus" NOT NULL DEFAULT 'ACTIVE',
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoScenario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_did_key" ON "User"("did");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_did_idx" ON "User"("did");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSession_refreshTokenHash_key" ON "DeviceSession"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "DeviceSession_userId_idx" ON "DeviceSession"("userId");

-- CreateIndex
CREATE INDEX "DeviceSession_deviceId_idx" ON "DeviceSession"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceSession_expiresAt_idx" ON "DeviceSession"("expiresAt");

-- CreateIndex
CREATE INDEX "DeviceSession_revokedAt_idx" ON "DeviceSession"("revokedAt");

-- CreateIndex
CREATE INDEX "DeviceSession_trustRevokedAt_idx" ON "DeviceSession"("trustRevokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSession_userId_deviceId_key" ON "DeviceSession"("userId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "OtpChallenge_passwordSetupTokenHash_key" ON "OtpChallenge"("passwordSetupTokenHash");

-- CreateIndex
CREATE INDEX "OtpChallenge_phone_purpose_createdAt_idx" ON "OtpChallenge"("phone", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "OtpChallenge_userId_idx" ON "OtpChallenge"("userId");

-- CreateIndex
CREATE INDEX "OtpChallenge_expiresAt_idx" ON "OtpChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "OtpChallenge_consumedAt_idx" ON "OtpChallenge"("consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserPassword_userId_key" ON "UserPassword"("userId");

-- CreateIndex
CREATE INDEX "UserPassword_lockedUntil_idx" ON "UserPassword"("lockedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "Issuer_did_key" ON "Issuer"("did");

-- CreateIndex
CREATE INDEX "Credential_holderId_status_idx" ON "Credential"("holderId", "status");

-- CreateIndex
CREATE INDEX "Credential_issuerId_idx" ON "Credential"("issuerId");

-- CreateIndex
CREATE INDEX "CredentialAttribute_credentialId_idx" ON "CredentialAttribute"("credentialId");

-- CreateIndex
CREATE INDEX "ShareRequest_credentialId_idx" ON "ShareRequest"("credentialId");

-- CreateIndex
CREATE INDEX "ShareRequest_status_idx" ON "ShareRequest"("status");

-- CreateIndex
CREATE INDEX "VerificationRecord_credentialId_idx" ON "VerificationRecord"("credentialId");

-- CreateIndex
CREATE INDEX "VerificationRecord_createdAt_idx" ON "VerificationRecord"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_createdAt_idx" ON "ActivityLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationParticipant_conversationId_idx" ON "ConversationParticipant"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationParticipant_userId_idx" ON "ConversationParticipant"("userId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "FeedPost_publishedAt_idx" ON "FeedPost"("publishedAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_userId_createdAt_idx" ON "PaymentTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_status_idx" ON "PaymentTransaction"("status");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MiniApp_slug_key" ON "MiniApp"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "DemoScenario_slug_key" ON "DemoScenario"("slug");

-- AddForeignKey
ALTER TABLE "DeviceSession" ADD CONSTRAINT "DeviceSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpChallenge" ADD CONSTRAINT "OtpChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPassword" ADD CONSTRAINT "UserPassword_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "Issuer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialAttribute" ADD CONSTRAINT "CredentialAttribute_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareRequest" ADD CONSTRAINT "ShareRequest_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRecord" ADD CONSTRAINT "VerificationRecord_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

