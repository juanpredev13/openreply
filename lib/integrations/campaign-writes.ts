import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { createAutomationSchema, createCampaign } from "@/lib/campaigns/create";
import { createInstagramContext, getUserMedia } from "@/lib/instagram/provider";
import { requireScope, type ServiceContext } from "./auth";
import { ApiError } from "./http";

// Fields an API key may set when creating a campaign. Everything else keeps
// the dashboard defaults. Opening DMs and follow gates are left to the UI.
const createArgs = z
  .object({
    name: z.string(),
    instagramAccountId: z.string().optional(),
    postId: z.string().optional(),
    postUrl: z.string().optional(),
    matchAnyPost: z.boolean().optional(),
    matchLive: z.boolean().optional(),
    pendingNextReel: z.boolean().optional(),
    keywords: z.array(z.string()).optional(),
    matchAnyWord: z.boolean().optional(),
    wholeWordMatch: z.boolean().optional(),
    dmTriggerEnabled: z.boolean().optional(),
    dmMessage: z.string(),
    trackedDestinationUrl: z.string().optional(),
    linkButtonLabel: z.string().optional(),
    publicReplyEnabled: z.boolean().optional(),
    publicReplyMessages: z.array(z.string()).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const createCampaignInputSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    instagramAccountId: { type: "string", description: "Defaults to the most recently connected account. See list_instagram_accounts." },
    postId: { type: "string", description: "Instagram media id from list_posts. Required unless matchAnyPost, pendingNextReel or matchLive." },
    postUrl: { type: "string", description: "Permalink of the post, from list_posts." },
    matchAnyPost: { type: "boolean", description: "Trigger on comments on any post or reel." },
    pendingNextReel: { type: "boolean", description: "Attach to the next reel that is published." },
    matchLive: { type: "boolean", description: "Trigger on comments during the account's Instagram Live broadcasts. DMs only go out while the live is on air, one per comment." },
    keywords: { type: "array", items: { type: "string", maxLength: 50 }, maxItems: 10, description: "Trigger words, case insensitive." },
    matchAnyWord: { type: "boolean", description: "Trigger on any comment, ignoring keywords." },
    wholeWordMatch: { type: "boolean", description: "Default true. False also matches inside longer words." },
    dmTriggerEnabled: { type: "boolean", description: "Also reply when someone DMs one of the keywords." },
    dmMessage: { type: "string", minLength: 1, maxLength: 1000, description: "DM text. {username} personalizes, {link} inserts the tracked link." },
    trackedDestinationUrl: { type: "string", format: "uri", description: "Link sent as a tracked button." },
    linkButtonLabel: { type: "string", maxLength: 20 },
    publicReplyEnabled: { type: "boolean" },
    publicReplyMessages: { type: "array", items: { type: "string", maxLength: 1000 }, maxItems: 10, description: "Public replies, rotated." },
    isActive: { type: "boolean", description: "Default false: the campaign is created paused. Set true to start sending DMs." },
  },
  required: ["name", "dmMessage"],
  additionalProperties: false,
} as const;

async function logWrite(context: ServiceContext, message: string, payload: Record<string, unknown>) {
  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: context.workspaceId,
        source: "SYSTEM",
        level: "INFO",
        message,
        payload: { keyId: context.keyId, ...payload },
      },
    })
    .catch(() => {});
}

export async function createCampaignFromKey(context: ServiceContext, args: unknown) {
  requireScope(context, "campaigns:write");
  const shape = createArgs.safeParse(args);
  if (!shape.success) throw new ApiError("Invalid campaign arguments");
  // API-created campaigns start paused unless the caller opts in explicitly.
  const parsed = createAutomationSchema.safeParse({ isActive: false, ...shape.data });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(`Invalid campaign: ${issue?.path.join(".") || "input"} ${issue?.message ?? ""}`.trim());
  }
  const result = await createCampaign(context.workspaceId, parsed.data);
  if (!result.ok) throw new ApiError(result.error, result.status);
  const { automation } = result;
  await logWrite(context, "Campaign created via API key", { campaignId: automation.id, isActive: automation.isActive });
  return {
    id: automation.id,
    name: automation.name,
    isActive: automation.isActive,
    postId: automation.postId,
    matchAnyPost: automation.matchAnyPost,
    pendingNextReel: automation.pendingNextReel,
    keywords: automation.keywords,
    trackedLinks: automation.trackedLinks.map((link) => link.destinationUrl),
  };
}

export async function setCampaignActive(context: ServiceContext, args: unknown) {
  requireScope(context, "campaigns:write");
  const input = z.object({ id: z.string().min(1).max(100), isActive: z.boolean() }).strict().safeParse(args);
  if (!input.success) throw new ApiError("Campaign id and isActive required");
  const updated = await prisma.automation.updateMany({
    where: { id: input.data.id, workspaceId: context.workspaceId },
    data: { isActive: input.data.isActive },
  });
  if (!updated.count) throw new ApiError("Campaign not found", 404);
  await logWrite(context, input.data.isActive ? "Campaign activated via API key" : "Campaign paused via API key", { campaignId: input.data.id });
  return { id: input.data.id, isActive: input.data.isActive };
}

export async function listInstagramAccounts(context: ServiceContext) {
  requireScope(context, "campaigns:write");
  return prisma.instagramAccount.findMany({
    where: { workspaceId: context.workspaceId },
    select: { id: true, username: true, provider: true, connectedAt: true },
    orderBy: { connectedAt: "desc" },
  });
}

export async function listPosts(context: ServiceContext, args: unknown) {
  requireScope(context, "campaigns:write");
  const input = z
    .object({ instagramAccountId: z.string().min(1).optional(), limit: z.number().int().min(1).max(50).optional() })
    .strict()
    .safeParse(args);
  if (!input.success) throw new ApiError("Invalid arguments");
  const account = await prisma.instagramAccount.findFirst({
    where: {
      workspaceId: context.workspaceId,
      ...(input.data.instagramAccountId ? { id: input.data.instagramAccountId } : {}),
    },
    orderBy: { connectedAt: "desc" },
    select: { provider: true, workspaceId: true, zernioAccountId: true, instagramId: true, accessToken: true },
  });
  if (!account) throw new ApiError("Instagram account not found", 404);
  const media = await getUserMedia({
    context: await createInstagramContext(account),
    limit: input.data.limit ?? 12,
  });
  return media.map((m) => ({
    id: m.id,
    caption: (m.caption ?? "").slice(0, 120),
    type: m.media_product_type ?? m.media_type,
    permalink: m.permalink ?? null,
    timestamp: m.timestamp,
    comments: m.comments_count ?? null,
  }));
}
