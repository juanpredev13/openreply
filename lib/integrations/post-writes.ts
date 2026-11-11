import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { createAutomationSchema } from "@/lib/campaigns/create";
import { decryptToken } from "@/lib/meta/oauth";
import { MetaApiError, PermissionError, publishMedia, type PublishMediaItem } from "@/lib/meta/client";
import { requireScope, type ServiceContext } from "./auth";
import { createCampaignFromKey } from "./campaign-writes";
import { ApiError } from "./http";

const httpsUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => value.startsWith("https://"), "must be an https URL");

// Campaign fields that make sense next to a post that is being published:
// the post id, url and account come from the publish itself.
const campaignArgs = z
  .object({
    name: z.string(),
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

const publishArgs = z
  .object({
    instagramAccountId: z.string().min(1).max(100).optional(),
    caption: z.string().max(2200),
    media: z
      .array(z.object({ type: z.enum(["IMAGE", "VIDEO"]), url: httpsUrl }).strict())
      .min(1)
      .max(10),
    shareReelToFeed: z.boolean().optional(),
    campaign: campaignArgs.optional(),
  })
  .strict();

export const publishPostInputSchema = {
  type: "object",
  properties: {
    instagramAccountId: { type: "string", description: "Defaults to the most recently connected account. See list_instagram_accounts." },
    caption: { type: "string", maxLength: 2200, description: "Post caption, up to 30 hashtags." },
    media: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description: "One IMAGE is a photo post, one VIDEO is a reel, 2 to 10 items are a carousel. Meta downloads each url, so it must be public HTTPS: JPEG for images, MP4 for videos.",
      items: {
        type: "object",
        properties: { type: { type: "string", enum: ["IMAGE", "VIDEO"] }, url: { type: "string", format: "uri" } },
        required: ["type", "url"],
        additionalProperties: false,
      },
    },
    shareReelToFeed: { type: "boolean", description: "Single video only. Default true: the reel also shows in the profile grid." },
    campaign: {
      type: "object",
      description: "Optional comment-to-DM campaign attached to the new post. Same fields as create_campaign, without post or account fields. Starts paused unless isActive is true.",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        keywords: { type: "array", items: { type: "string", maxLength: 50 }, maxItems: 10 },
        matchAnyWord: { type: "boolean" },
        wholeWordMatch: { type: "boolean" },
        dmTriggerEnabled: { type: "boolean" },
        dmMessage: { type: "string", minLength: 1, maxLength: 1000 },
        trackedDestinationUrl: { type: "string", format: "uri" },
        linkButtonLabel: { type: "string", maxLength: 20 },
        publicReplyEnabled: { type: "boolean" },
        publicReplyMessages: { type: "array", items: { type: "string", maxLength: 1000 }, maxItems: 10 },
        isActive: { type: "boolean" },
      },
      required: ["name", "dmMessage"],
      additionalProperties: false,
    },
  },
  required: ["caption", "media"],
  additionalProperties: false,
} as const;

function metaFailure(error: unknown): never {
  if (error instanceof PermissionError) {
    throw new ApiError(
      "Instagram refused to publish. Reconnect the account in Settings so it grants instagram_content_publish, then try again.",
      403
    );
  }
  if (error instanceof MetaApiError) throw new ApiError(`Instagram publish failed: ${error.message}`, 502);
  throw error;
}

export async function publishPostFromKey(context: ServiceContext, args: unknown) {
  requireScope(context, "posts:publish");
  const input = publishArgs.safeParse(args);
  if (!input.success) {
    const issue = input.error.issues[0];
    throw new ApiError(`Invalid post: ${issue?.path.join(".") || "input"} ${issue?.message ?? ""}`.trim());
  }
  const { instagramAccountId, caption, media, shareReelToFeed, campaign } = input.data;

  // Validate the campaign before publishing, so a bad campaign never leaves a
  // published post without its automation.
  if (campaign) {
    const check = createAutomationSchema.safeParse({ isActive: false, ...campaign, postId: "pending" });
    if (!check.success) {
      const issue = check.error.issues[0];
      throw new ApiError(`Invalid campaign: ${issue?.path.join(".") || "input"} ${issue?.message ?? ""}`.trim());
    }
  }

  const account = await prisma.instagramAccount.findFirst({
    where: { workspaceId: context.workspaceId, ...(instagramAccountId ? { id: instagramAccountId } : {}) },
    orderBy: { connectedAt: "desc" },
    select: { id: true, provider: true, accessToken: true },
  });
  if (!account) throw new ApiError("Instagram account not found", 404);
  if (account.provider !== "META" || !account.accessToken) {
    throw new ApiError("Publishing is only supported for accounts connected directly with Meta");
  }

  let post: { id: string; permalink: string | null };
  try {
    post = await publishMedia(decryptToken(account.accessToken), {
      items: media as PublishMediaItem[],
      caption,
      shareReelToFeed,
    });
  } catch (error) {
    metaFailure(error);
  }

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: context.workspaceId,
        source: "SYSTEM",
        level: "INFO",
        message: "Instagram post published via API key",
        payload: { keyId: context.keyId, postId: post.id, instagramAccountId: account.id, items: media.length },
      },
    })
    .catch(() => {});

  const result: {
    postId: string;
    permalink: string | null;
    campaign?: Awaited<ReturnType<typeof createCampaignFromKey>>;
    campaignError?: string;
  } = { postId: post.id, permalink: post.permalink };

  if (campaign) {
    try {
      result.campaign = await createCampaignFromKey(context, {
        ...campaign,
        instagramAccountId: account.id,
        postId: post.id,
        ...(post.permalink ? { postUrl: post.permalink } : {}),
      });
    } catch (error) {
      // The post is already public; report the campaign failure instead of
      // hiding the post id behind an error.
      result.campaignError = error instanceof ApiError ? error.message : "Campaign could not be created";
    }
  }
  return result;
}
