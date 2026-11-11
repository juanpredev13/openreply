import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  instagramAccount: { findFirst: vi.fn() },
  automation: { create: vi.fn() },
  operationalEvent: { create: vi.fn() },
  workspace: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain-${value}` }));

import { callTool, listTools, serverInstructions } from "../lib/integrations/mcp";
import { publishMedia } from "../lib/meta/client";

const writer = { workspaceId: "ws", keyId: "key", scopes: ["campaigns:read", "campaigns:write"] };
const publisher = { workspaceId: "ws", keyId: "key", scopes: ["campaigns:read", "campaigns:write", "posts:publish"] };
const image = { type: "IMAGE", url: "https://cdn.example.test/a.jpg" };

type Call = { url: URL; body: URLSearchParams | null };
let calls: Call[];
let responses: Array<(call: Call) => unknown>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("META_LOGIN_MODE", "unified");
  vi.stubEnv("NEXTAUTH_URL", "https://example.test");
  calls = [];
  responses = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const call = { url: new URL(input), body: init?.body ? new URLSearchParams(init.body as URLSearchParams) : null };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${call.url.pathname}`);
    const result = next(call);
    return result instanceof Response ? result : json(result);
  }));
  db.instagramAccount.findFirst.mockResolvedValue({ id: "acc", provider: "META", accessToken: "enc" });
  db.automation.create.mockImplementation(async ({ data }) => ({ id: "camp", ...data, trackedLinks: [] }));
  db.operationalEvent.create.mockResolvedValue({});
  db.workspace.findUnique.mockResolvedValue({ id: "ws" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("publishMedia", () => {
  it("publishes a single image through a container", async () => {
    responses.push(
      () => ({ instagram_business_account: { id: "ig1" } }),
      () => ({ id: "c1" }),
      () => ({ status_code: "FINISHED" }),
      () => ({ id: "m1" }),
      () => ({ permalink: "https://www.instagram.com/p/x/" }),
    );
    const post = await publishMedia("tok-single", { items: [image as never], caption: "hola" }, { pollIntervalMs: 1 });
    expect(post).toEqual({ id: "m1", permalink: "https://www.instagram.com/p/x/" });
    expect(calls[1].url.pathname).toMatch(/\/ig1\/media$/);
    expect(calls[1].body?.get("image_url")).toBe(image.url);
    expect(calls[1].body?.get("caption")).toBe("hola");
    expect(calls[3].url.pathname).toMatch(/\/ig1\/media_publish$/);
    expect(calls[3].body?.get("creation_id")).toBe("c1");
    // The token never travels in a URL on writes.
    expect(calls[1].url.search).toBe("");
  });

  it("builds carousels from child containers and publishes videos as reels", async () => {
    responses.push(
      () => ({ instagram_business_account: { id: "ig2" } }),
      () => ({ id: "k1" }),
      () => ({ id: "k2" }),
      () => ({ status_code: "FINISHED" }),
      () => ({ status_code: "IN_PROGRESS" }),
      () => ({ status_code: "FINISHED" }),
      () => ({ id: "parent" }),
      () => ({ status_code: "FINISHED" }),
      () => ({ id: "m2" }),
      () => ({ permalink: null }),
    );
    await publishMedia("tok-carousel", {
      items: [image as never, { type: "VIDEO", url: "https://cdn.example.test/b.mp4" }],
      caption: "carrusel",
    }, { pollIntervalMs: 1 });
    expect(calls[1].body?.get("is_carousel_item")).toBe("true");
    expect(calls[2].body?.get("media_type")).toBe("VIDEO");
    expect(calls[6].body?.get("media_type")).toBe("CAROUSEL");
    expect(calls[6].body?.get("children")).toBe("k1,k2");

    calls = [];
    responses.push(
      () => ({ id: "r1" }),
      () => ({ status_code: "FINISHED" }),
      () => ({ id: "m3" }),
      () => ({ permalink: "https://www.instagram.com/reel/y/" }),
    );
    await publishMedia("tok-carousel", { items: [{ type: "VIDEO", url: "https://cdn.example.test/c.mp4" }], caption: "reel" }, { pollIntervalMs: 1 });
    expect(calls[0].body?.get("media_type")).toBe("REELS");
    expect(calls[0].body?.get("share_to_feed")).toBe("true");
  });

  it("stops when Instagram rejects the media", async () => {
    responses.push(
      () => ({ instagram_business_account: { id: "ig3" } }),
      () => ({ id: "c3" }),
      () => ({ status_code: "ERROR", status: "Error: unsupported format" }),
    );
    await expect(publishMedia("tok-error", { items: [image as never], caption: "" }, { pollIntervalMs: 1 }))
      .rejects.toThrow(/could not process the media/);
    expect(calls.some((call) => call.url.pathname.endsWith("media_publish"))).toBe(false);
  });
});

describe("publish_post tool", () => {
  it("needs the posts:publish scope", async () => {
    expect(listTools(writer).map((t) => t.name)).not.toContain("publish_post");
    await expect(callTool(writer, "publish_post", { caption: "x", media: [image] })).rejects.toMatchObject({ status: 403 });
    expect(listTools(publisher).map((t) => t.name)).toContain("publish_post");
    expect(serverInstructions(publisher)).toMatch(/publish Instagram posts/);
  });

  it("rejects non-https media and invalid campaigns before publishing", async () => {
    await expect(callTool(publisher, "publish_post", { caption: "x", media: [{ type: "IMAGE", url: "http://a.test/a.jpg" }] }))
      .rejects.toThrow(/https/);
    await expect(callTool(publisher, "publish_post", { caption: "x", media: [image], campaign: { name: "A", dmMessage: "hola" } }))
      .rejects.toThrow(/Invalid campaign/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("publishes and attaches a paused campaign to the new post", async () => {
    responses.push(
      () => ({ instagram_business_account: { id: "ig4" } }),
      () => ({ id: "c4" }),
      () => ({ status_code: "FINISHED" }),
      () => ({ id: "m4" }),
      () => ({ permalink: "https://www.instagram.com/p/z/" }),
    );
    const result = await callTool(publisher, "publish_post", {
      caption: "Comenta AYUDA",
      media: [image],
      campaign: { name: "AYUDA", keywords: ["ayuda"], dmMessage: "Hola {username}" },
    });
    expect(result).toMatchObject({ postId: "m4", permalink: "https://www.instagram.com/p/z/", campaign: { id: "camp", isActive: false, postId: "m4" } });
    expect(db.automation.create.mock.calls[0][0].data).toMatchObject({ workspaceId: "ws", instagramAccountId: "acc", postId: "m4", postUrl: "https://www.instagram.com/p/z/" });
    expect(db.operationalEvent.create.mock.calls[0][0].data).toMatchObject({ message: "Instagram post published via API key", payload: { keyId: "key", postId: "m4" } });
  });

  it("explains a missing publish permission", async () => {
    responses.push(
      () => ({ instagram_business_account: { id: "ig5" } }),
      () => json({ error: { code: 10, message: "Application does not have permission for this action" } }, 403),
    );
    await expect(callTool(publisher, "publish_post", { caption: "x", media: [image] }))
      .rejects.toThrow(/Reconnect the account/);
  });
});
