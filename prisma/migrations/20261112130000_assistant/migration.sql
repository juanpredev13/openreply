-- Additive only: AI assistant for Instagram DMs.
CREATE TABLE "AssistantConfig" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "businessInfo" TEXT NOT NULL DEFAULT '',
  "handoffMessage" TEXT NOT NULL DEFAULT '',
  "whatsappUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssistantConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssistantConfig_workspaceId_key" ON "AssistantConfig"("workspaceId");
ALTER TABLE "AssistantConfig" ADD CONSTRAINT "AssistantConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AssistantThread" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "instagramAccountId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "username" TEXT,
  "paused" BOOLEAN NOT NULL DEFAULT false,
  "pausedReason" TEXT,
  "lastProcessedMessageId" TEXT,
  "lastReplyAt" TIMESTAMP(3),
  "replyCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssistantThread_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssistantThread_instagramAccountId_userId_key" ON "AssistantThread"("instagramAccountId", "userId");
CREATE INDEX "AssistantThread_workspaceId_paused_idx" ON "AssistantThread"("workspaceId", "paused");
ALTER TABLE "AssistantThread" ADD CONSTRAINT "AssistantThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantThread" ADD CONSTRAINT "AssistantThread_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
