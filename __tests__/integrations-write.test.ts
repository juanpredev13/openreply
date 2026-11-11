import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  workspace: { findUnique: vi.fn() },
  instagramAccount: { findFirst: vi.fn(), findMany: vi.fn() },
  automation: { create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  operationalEvent: { create: vi.fn() },
  serviceKey: { create: vi.fn() },
  media: vi.fn(),
  context: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    workspace: db.workspace,
    instagramAccount: db.instagramAccount,
    automation: db.automation,
    operationalEvent: db.operationalEvent,
    serviceKey: db.serviceKey,
  },
}));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn(async () => ({ provider: "META", accessToken: "t" })),
  getUserMedia: db.media,
}));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: db.context,
  canManageWorkspace: (role: string) => ["OWNER", "ADMIN"].includes(role),
}));

import { callTool, listTools, serverInstructions } from "../lib/integrations/mcp";
import { POST as createKey } from "../app/api/integrations/keys/route";

const reader = { workspaceId: "ws", keyId: "key", scopes: ["campaigns:read"] };
const writer = { workspaceId: "ws", keyId: "key", scopes: ["campaigns:read", "campaigns:write"] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_URL", "https://example.test");
  db.workspace.findUnique.mockResolvedValue({ id: "ws" });
  db.instagramAccount.findFirst.mockResolvedValue({ id: "acc", provider: "META", workspaceId: "ws", zernioAccountId: null, instagramId: "ig", accessToken: "enc" });
  db.automation.create.mockImplementation(async ({ data }) => ({ id: "camp", ...data, trackedLinks: [] }));
  db.automation.updateMany.mockResolvedValue({ count: 1 });
  db.operationalEvent.create.mockResolvedValue({});
  db.context.mockResolvedValue({ workspaceId: "ws", role: "ADMIN" });
});

describe("MCP write tools", () => {
  it("are hidden from read-only keys and refused when called", async () => {
    expect(listTools(reader).map((t) => t.name)).toEqual(["list_campaigns", "get_campaign", "get_campaign_stats"]);
    await expect(callTool(reader, "create_campaign", { name: "x", dmMessage: "y" })).rejects.toMatchObject({ status: 403 });
    await expect(callTool(reader, "set_campaign_active", { id: "c", isActive: true })).rejects.toMatchObject({ status: 403 });
    expect(db.automation.create).not.toHaveBeenCalled();
    expect(serverInstructions(reader)).toMatch(/Read-only/);
  });

  it("are listed for write keys with honest annotations", () => {
    const tools = listTools(writer);
    expect(tools.map((t) => t.name)).toEqual([
      "list_campaigns", "get_campaign", "get_campaign_stats",
      "list_instagram_accounts", "list_posts", "create_campaign", "set_campaign_active",
    ]);
    expect(tools.find((t) => t.name === "create_campaign")?.annotations.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "list_posts")?.annotations.readOnlyHint).toBe(true);
    expect(serverInstructions(writer)).toMatch(/start paused/);
  });

  it("creates campaigns paused by default, scoped to the key's workspace, and logs it", async () => {
    const result = await callTool(writer, "create_campaign", {
      name: "AYUDA", postId: "m1", keywords: ["ayuda"], dmMessage: "Hola {username}",
      publicReplyEnabled: true, publicReplyMessages: ["Revisa tu DM"],
    });
    expect(result).toMatchObject({ id: "camp", isActive: false, postId: "m1", keywords: ["ayuda"] });
    const data = db.automation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ workspaceId: "ws", instagramAccountId: "acc", isActive: false, wholeWordMatch: true, publicReplyMessages: ["Revisa tu DM"] });
    expect(db.operationalEvent.create.mock.calls[0][0].data).toMatchObject({ workspaceId: "ws", message: "Campaign created via API key", payload: { keyId: "key", campaignId: "camp" } });
  });

  it("creates an active campaign only when asked explicitly", async () => {
    await callTool(writer, "create_campaign", { name: "A", matchAnyPost: true, keywords: ["menu"], dmMessage: "x", isActive: true });
    expect(db.automation.create.mock.calls[0][0].data.isActive).toBe(true);
  });

  it("applies the dashboard validation", async () => {
    await expect(callTool(writer, "create_campaign", { name: "A", keywords: ["x"], dmMessage: "x" })).rejects.toThrow(/postId/);
    await expect(callTool(writer, "create_campaign", { name: "A", postId: "m", dmMessage: "x" })).rejects.toThrow(/keywords/);
    await expect(callTool(writer, "create_campaign", { name: "A", postId: "m", keywords: ["x"], dmMessage: "x", requireFollow: true })).rejects.toThrow(/Invalid campaign arguments/);
    expect(db.automation.create).not.toHaveBeenCalled();
  });

  it("refuses an Instagram account from another workspace", async () => {
    db.instagramAccount.findFirst.mockResolvedValue(null);
    await expect(callTool(writer, "create_campaign", { name: "A", postId: "m", keywords: ["x"], dmMessage: "x", instagramAccountId: "foreign" }))
      .rejects.toMatchObject({ status: 400 });
    expect(db.instagramAccount.findFirst.mock.calls[0][0].where).toMatchObject({ id: "foreign", workspaceId: "ws" });
  });

  it("toggles only campaigns in the key's workspace", async () => {
    expect(await callTool(writer, "set_campaign_active", { id: "camp", isActive: true })).toEqual({ id: "camp", isActive: true });
    expect(db.automation.updateMany.mock.calls[0][0]).toEqual({ where: { id: "camp", workspaceId: "ws" }, data: { isActive: true } });
    db.automation.updateMany.mockResolvedValue({ count: 0 });
    await expect(callTool(writer, "set_campaign_active", { id: "other", isActive: false })).rejects.toMatchObject({ status: 404 });
  });

  it("lists posts with short captions", async () => {
    db.media.mockResolvedValue([{ id: "m1", caption: "x".repeat(300), media_type: "IMAGE", media_product_type: "FEED", permalink: "https://i/p/1", timestamp: "t", comments_count: 2 }]);
    const posts = await callTool(writer, "list_posts", { limit: 5 });
    expect(posts).toEqual([{ id: "m1", caption: "x".repeat(120), type: "FEED", permalink: "https://i/p/1", timestamp: "t", comments: 2 }]);
    expect(db.media.mock.calls[0][0].limit).toBe(5);
  });
});

describe("write keys", () => {
  const req = (body: unknown) => new Request("https://example.test/api/integrations/keys", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://example.test" }, body: JSON.stringify(body),
  });

  it("always include the read scope", async () => {
    db.serviceKey.create.mockImplementation(async ({ data }) => ({ id: "k", name: data.name, scopes: data.scopes, expiresAt: data.expiresAt }));
    const response = await createKey(req({ name: "Writer", scopes: ["campaigns:write"] }));
    expect(response.status).toBe(201);
    expect(db.serviceKey.create.mock.calls[0][0].data.scopes.sort()).toEqual(["campaigns:read", "campaigns:write"]);
  });
});
