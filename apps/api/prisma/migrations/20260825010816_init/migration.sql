-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('DRAFT', 'CONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('WAITING_USER_MESSAGE', 'USER_REPLIED', 'FORM_SENT');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('COMMENT_RECEIVED', 'COMMENT_SKIPPED', 'PRIVATE_REPLY_SENT', 'USER_REPLIED', 'FOLLOW_UP_SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "SkipReason" AS ENUM ('SELF_COMMENT', 'NO_KEYWORD_MATCH', 'DUPLICATE', 'CAMPAIGN_DISABLED', 'ECHO', 'NO_TEXT', 'ACCOUNT_MISMATCH');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IgAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "igUserId" TEXT NOT NULL,
    "username" TEXT,
    "slug" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "appSecretEnc" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'DRAFT',
    "subscribedAt" TIMESTAMP(3),
    "tokenExpiresAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "defaultPrivateReplyText" TEXT,
    "defaultFollowUpText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IgAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "igAccountId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "permalink" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "caption" TEXT,
    "label" TEXT,
    "triggerKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "privateReplyText" TEXT,
    "followUpText" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "igAccountId" TEXT NOT NULL,
    "igsid" TEXT NOT NULL,
    "state" "ConversationState" NOT NULL,
    "lastCommentId" TEXT,
    "lastMediaId" TEXT,
    "lastCampaignId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SentReply" (
    "igAccountId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SentReply_pkey" PRIMARY KEY ("igAccountId","commentId")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "igAccountId" TEXT NOT NULL,
    "campaignId" TEXT,
    "mediaId" TEXT,
    "igsid" TEXT,
    "username" TEXT,
    "type" "EventType" NOT NULL,
    "skipReason" "SkipReason",
    "errorCode" TEXT,
    "latencyMs" INTEGER,
    "isFollower" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "IgAccount_igUserId_key" ON "IgAccount"("igUserId");

-- CreateIndex
CREATE UNIQUE INDEX "IgAccount_slug_key" ON "IgAccount"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_igAccountId_mediaId_key" ON "Campaign"("igAccountId", "mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_igAccountId_igsid_key" ON "Conversation"("igAccountId", "igsid");

-- CreateIndex
CREATE INDEX "Event_igAccountId_createdAt_idx" ON "Event"("igAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "Event_igAccountId_mediaId_type_idx" ON "Event"("igAccountId", "mediaId", "type");

-- AddForeignKey
ALTER TABLE "IgAccount" ADD CONSTRAINT "IgAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SentReply" ADD CONSTRAINT "SentReply_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_igAccountId_fkey" FOREIGN KEY ("igAccountId") REFERENCES "IgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
