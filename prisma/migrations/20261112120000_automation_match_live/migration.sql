-- Additive only: campaigns can opt in to Instagram Live comments.
ALTER TABLE "Automation" ADD COLUMN "matchLive" BOOLEAN NOT NULL DEFAULT false;
