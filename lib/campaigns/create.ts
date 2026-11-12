import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { buildInitialCampaignLinks } from "@/lib/campaigns/links";
import { generateReportShareSlug } from "@/lib/reports/share";

// Shared by the dashboard route and the MCP create_campaign tool, so both
// accept exactly the same campaigns.
export const createAutomationSchema = z
  .object({
    name: z.string().min(1).max(100),
    goal: z.string().min(1).max(120).optional().nullable(),
    instagramAccountId: z.string().min(1).optional().nullable(),
    postId: z.string().min(1).optional().nullable(),
    postUrl: z.string().url().optional().nullable(),
    pendingNextReel: z.boolean().optional().default(false),
    matchAnyPost: z.boolean().optional().default(false),
    matchLive: z.boolean().optional().default(false),
    keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
    matchAnyWord: z.boolean().optional().default(false),
    dmTriggerEnabled: z.boolean().optional().default(false),
    dmMessage: z.string().min(1).max(1000),
    openingDmEnabled: z.boolean().optional().default(false),
    openingDmMessage: z.string().max(1000).optional().nullable(),
    openingDmButtonLabel: z.string().max(64).optional().nullable(),
    linkButtonLabel: z.string().max(20).optional().nullable(),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().max(1000).optional().nullable(),
    followPromptButtonLabel: z.string().max(20).optional().nullable(),
    followUpEnabled: z.boolean().optional().default(false),
    followUpMessage: z.string().max(1000).optional().nullable(),
    // Minutes to wait before the follow-up. Capped at 24h so it stays inside
    // Instagram's messaging window.
    followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
    publicReplyEnabled: z.boolean().optional().default(false),
    publicReplyMessage: z.string().max(1000).optional().nullable(),
    publicReplyMessages: z
      .array(z.string().max(1000))
      .max(10)
      .optional()
      .default([]),
    // Empty string means "no tracked link"; a URL sets one.
    trackedDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    // Optional second tracked link, rendered as a second DM button.
    secondaryDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    secondaryButtonLabel: z.string().max(20).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    wholeWordMatch: z.boolean().optional().default(true),
  })
  // A campaign must target a specific post, any post, or the next reel.
  .refine(
    (d) => d.matchAnyPost || d.pendingNextReel || d.matchLive || Boolean(d.postId),
    { message: "Choose which post(s) trigger the campaign", path: ["postId"] }
  )
  // And it must match either specific words or any word.
  .refine((d) => d.matchAnyWord || d.keywords.length >= 1, {
    message: "Add at least one keyword, or match any word",
    path: ["keywords"],
  })
  // An opening DM needs both a message and a button label.
  .refine(
    (d) =>
      !d.openingDmEnabled ||
      (Boolean(d.openingDmMessage?.trim()) &&
        Boolean(d.openingDmButtonLabel?.trim())),
    { message: "Opening DM needs a message and a button label", path: ["openingDmMessage"] }
  );

export type CreateCampaignInput = z.output<typeof createAutomationSchema>;

export type CreateCampaignResult =
  | { ok: true; automation: Awaited<ReturnType<typeof insertCampaign>> }
  | { ok: false; status: number; error: string };

export async function createCampaign(
  workspaceId: string,
  input: CreateCampaignInput
): Promise<CreateCampaignResult> {
  const requestedInstagramAccountId =
    input.instagramAccountId && input.instagramAccountId !== "all"
      ? input.instagramAccountId
      : null;

  const [workspace, instagramAccount] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    }),
    requestedInstagramAccountId
      ? prisma.instagramAccount.findFirst({
          where: { id: requestedInstagramAccountId, workspaceId },
        })
      : prisma.instagramAccount.findFirst({
          where: { workspaceId },
          orderBy: { connectedAt: "desc" },
        }),
  ]);

  if (!workspace) {
    return { ok: false, status: 404, error: "Workspace not found" };
  }

  if (!instagramAccount) {
    return { ok: false, status: 400, error: "Connect Instagram before creating campaigns" };
  }

  const linkCreates = buildInitialCampaignLinks({
    workspaceId,
    primaryUrl: input.trackedDestinationUrl,
    secondaryUrl: input.secondaryDestinationUrl,
    secondaryLabel: input.secondaryButtonLabel,
  });

  const { pendingNextReel, matchAnyPost, matchLive, matchAnyWord, openingDmEnabled } =
    input;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost && !matchLive;
  const publicReplyList = (
    input.publicReplyMessages.length > 0
      ? input.publicReplyMessages
      : input.publicReplyMessage
        ? [input.publicReplyMessage]
        : []
  )
    .map((m) => m.trim())
    .filter(Boolean);

  const automation = await insertCampaign({
    data: {
      name: input.name,
      goal: input.goal,
      // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
      postId: isSpecificPost ? input.postId : null,
      postUrl: isSpecificPost ? input.postUrl : null,
      pendingNextReel,
      matchAnyPost,
      matchLive,
      keywords: matchAnyWord ? [] : input.keywords,
      matchAnyWord,
      dmTriggerEnabled: input.dmTriggerEnabled,
      dmMessage: input.dmMessage,
      openingDmEnabled,
      openingDmMessage: openingDmEnabled
        ? input.openingDmMessage || null
        : null,
      openingDmButtonLabel: openingDmEnabled
        ? input.openingDmButtonLabel || null
        : null,
      linkButtonLabel: input.linkButtonLabel || null,
      requireFollow: input.requireFollow,
      followPromptMessage: input.requireFollow
        ? input.followPromptMessage || null
        : null,
      followPromptButtonLabel: input.requireFollow
        ? input.followPromptButtonLabel || null
        : null,
      followUpEnabled: input.followUpEnabled,
      followUpMessage: input.followUpEnabled
        ? input.followUpMessage || null
        : null,
      followUpDelayMinutes: input.followUpEnabled
        ? input.followUpDelayMinutes
        : 0,
      publicReplyEnabled: input.publicReplyEnabled,
      publicReplyMessages: input.publicReplyEnabled
        ? publicReplyList
        : [],
      publicReplyMessage: input.publicReplyEnabled
        ? publicReplyList[0] ?? input.publicReplyMessage ?? null
        : null,
      isActive: input.isActive,
      wholeWordMatch: input.wholeWordMatch,
      workspaceId,
      instagramAccountId: instagramAccount.id,
      reportShareSlug: generateReportShareSlug(),
      ...(linkCreates.length > 0
        ? { trackedLinks: { create: linkCreates } }
        : {}),
    },
  });

  return { ok: true, automation };
}

function insertCampaign({ data }: { data: Parameters<typeof prisma.automation.create>[0]["data"] }) {
  return prisma.automation.create({ data, include: { trackedLinks: true } });
}
