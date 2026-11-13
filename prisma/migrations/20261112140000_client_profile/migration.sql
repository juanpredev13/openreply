-- Additive only: client details for workspaces run for clients.
CREATE TABLE "ClientProfile" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "instagramHandle" TEXT,
  "whatsappNumber" TEXT,
  "whatsappAgentUrl" TEXT,
  "notes" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClientProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientProfile_workspaceId_key" ON "ClientProfile"("workspaceId");
ALTER TABLE "ClientProfile" ADD CONSTRAINT "ClientProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
