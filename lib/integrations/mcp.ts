import { z } from "zod";
import { getCampaign, getCampaignStats, listCampaigns } from "./campaigns";
import {
  createCampaignFromKey,
  createCampaignInputSchema,
  listInstagramAccounts,
  listPosts,
  setCampaignActive,
} from "./campaign-writes";
import { publishPostFromKey, publishPostInputSchema } from "./post-writes";
import { requireScope, type ServiceContext } from "./auth";
import { ApiError } from "./http";

const idSchema = { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 100 } }, required: ["id"], additionalProperties: false };
const readTools = [
  { name: "list_campaigns", description: "List up to 100 campaigns in this workspace; use get_campaign for complete settings and destination links.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_campaign", description: "Read campaign settings and ordered destination links. Missing links are null, not invented.", inputSchema: idSchema },
  { name: "get_campaign_stats", description: "Read aggregate send outcomes and raw link requests, not recipient conversions.", inputSchema: idSchema },
];
// Write tools need the campaigns:write scope. They create and toggle
// campaigns; none of them sends a message or deletes anything.
const writeTools = [
  { name: "list_instagram_accounts", description: "List the Instagram accounts connected to this workspace, to pick instagramAccountId.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, readOnly: true },
  { name: "list_posts", description: "List recent posts and reels of an Instagram account, to pick postId and postUrl for create_campaign.", inputSchema: { type: "object", properties: { instagramAccountId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false }, readOnly: true },
  { name: "create_campaign", description: "Create a comment-to-DM campaign. It is created paused unless isActive is true. Confirm the post, keywords and DM text with the user before activating.", inputSchema: createCampaignInputSchema, readOnly: false },
  { name: "set_campaign_active", description: "Activate or pause a campaign. An active campaign sends DMs to people who comment the keywords.", inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 100 }, isActive: { type: "boolean" } }, required: ["id", "isActive"], additionalProperties: false }, readOnly: false },
];
// Publishing makes content public on Instagram and cannot be undone through
// this API, so it needs its own posts:publish scope.
const publishTools = [
  { name: "publish_post", description: "Publish a photo, reel or carousel to Instagram from public HTTPS media URLs, optionally with a paused comment-to-DM campaign attached. The post is public immediately and cannot be deleted through this API: confirm the media, caption and account with the user first.", inputSchema: publishPostInputSchema },
];

export function listTools(context: ServiceContext) {
  const tools = [];
  if (context.scopes.includes("campaigns:read")) {
    tools.push(...readTools.map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })));
  }
  if (context.scopes.includes("campaigns:write")) {
    tools.push(...writeTools.map(({ readOnly, ...tool }) => ({ ...tool, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly || tool.name === "set_campaign_active", openWorldHint: !readOnly } })));
  }
  if (context.scopes.includes("posts:publish")) {
    tools.push(...publishTools.map(tool => ({ ...tool, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } })));
  }
  return tools;
}

export async function callTool(context: ServiceContext, name: string, args: unknown) {
  if (name === "publish_post") {
    requireScope(context, "posts:publish");
    return publishPostFromKey(context, args);
  }
  if (writeTools.some(tool => tool.name === name)) {
    requireScope(context, "campaigns:write");
    if (name === "list_instagram_accounts") {
      if (!z.object({}).strict().safeParse(args).success) throw new ApiError("Invalid tool arguments");
      return listInstagramAccounts(context);
    }
    if (name === "list_posts") return listPosts(context, args);
    if (name === "create_campaign") return createCampaignFromKey(context, args);
    return setCampaignActive(context, args);
  }
  requireScope(context, "campaigns:read");
  if (name === "list_campaigns") {
    if (!z.object({}).strict().safeParse(args).success) throw new ApiError("Invalid tool arguments");
    return listCampaigns(context);
  }
  if (!readTools.some(tool => tool.name === name)) throw new ApiError("Unknown tool", 404);
  const input = z.object({ id: z.string().min(1).max(100) }).strict().safeParse(args);
  if (!input.success) throw new ApiError("Campaign id required");
  return name === "get_campaign" ? getCampaign(context, input.data.id) : getCampaignStats(context, input.data.id);
}

export function serverInstructions(context: ServiceContext) {
  if (context.scopes.includes("posts:publish")) {
    return "Workspace-scoped. This key can publish Instagram posts and create, activate and pause campaigns; it cannot send messages directly or delete anything. Published posts are public at once, so confirm them with the user first. New campaigns start paused.";
  }
  return context.scopes.includes("campaigns:write")
    ? "Workspace-scoped. This key can create, activate and pause campaigns; it cannot send messages directly or delete anything. New campaigns start paused."
    : "Read-only and workspace-scoped. No tool can modify campaigns or send messages.";
}
