import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; instagramId: string; accessToken: string | null }>,
  live: [] as Array<{ id: string }>,
  comments: [] as Array<{ id: string; text: string; from?: { id: string; username?: string } }>,
  jobs: [] as Array<{ data: Record<string, unknown>; opts: Record<string, unknown> }>,
  liveCalls: 0,
  commentCalls: 0,
}));

vi.mock("@/lib/db/client", () => ({
  prisma: { instagramAccount: { findMany: vi.fn(async () => h.accounts) } },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: vi.fn(async (_name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => { h.jobs.push({ data, opts }); }) }),
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain-${value}` }));
vi.mock("@/lib/meta/client", () => ({
  getLiveMedia: vi.fn(async () => { h.liveCalls += 1; return h.live; }),
  getLiveComments: vi.fn(async () => { h.commentCalls += 1; return h.comments; }),
}));

import { parseCommentEvents } from "../lib/meta/webhook";
import { pollLiveComments } from "../lib/polling/live-comments";
import { createAutomationSchema } from "../lib/campaigns/create";

beforeEach(() => {
  h.accounts = [{ id: "acc", instagramId: "ig_me", accessToken: "enc" }];
  h.live = [];
  h.comments = [];
  h.jobs = [];
  h.liveCalls = 0;
  h.commentCalls = 0;
});

describe("live_comments webhook", () => {
  it("is parsed like a comment and flagged as live", () => {
    const events = parseCommentEvents({
      object: "instagram",
      entry: [{
        id: "ig_me",
        time: 1,
        changes: [{ field: "live_comments", value: { id: "c1", text: "quiero", from: { id: "u1", username: "ana" }, media: { id: "live1" } } }],
      }],
    } as never);
    expect(events).toEqual([expect.objectContaining({ commentId: "c1", mediaId: "live1", commenterId: "u1", isLive: true })]);
  });

  it("does not flag regular comments as live", () => {
    const events = parseCommentEvents({
      object: "instagram",
      entry: [{ id: "ig_me", time: 1, changes: [{ field: "comments", value: { id: "c2", text: "x", from: { id: "u1" }, media: { id: "p1" } } }] }],
    } as never);
    expect(events[0].isLive).toBeUndefined();
  });
});

describe("live comment polling", () => {
  it("does nothing when no account has an active live campaign", async () => {
    h.accounts = [];
    const result = await pollLiveComments(1_000_000);
    expect(result).toMatchObject({ accounts: 0, enqueued: 0 });
    expect(h.liveCalls).toBe(0);
  });

  it("only reads comments while the account is live", async () => {
    const result = await pollLiveComments(2_000_000);
    expect(result.live).toBe(0);
    expect(h.liveCalls).toBe(1);
    expect(h.commentCalls).toBe(0);
  });

  it("enqueues new live comments once, skipping the account's own comments", async () => {
    h.live = [{ id: "live1" }];
    h.comments = [
      { id: "lc1", text: "Quiero talla M", from: { id: "u1", username: "ana" } },
      { id: "lc2", text: "hola", from: { id: "ig_me" } },
    ];
    const first = await pollLiveComments(3_000_000);
    expect(first.enqueued).toBe(1);
    expect(h.jobs[0]).toEqual({
      data: expect.objectContaining({ commentId: "lc1", mediaId: "live1", commenterId: "u1", isLive: true, source: "POLLING", accountConnectionId: "acc" }),
      opts: { jobId: "comment_ig_me_lc1" },
    });

    // Next tick (before the next live check): comments are read again but not re-enqueued.
    const second = await pollLiveComments(3_008_000);
    expect(second.enqueued).toBe(0);
    expect(h.liveCalls).toBe(1); // live status is re-checked only every 30 s
    expect(h.commentCalls).toBe(2);
  });
});

describe("live campaigns", () => {
  it("do not need a post", () => {
    const parsed = createAutomationSchema.safeParse({ name: "Live", matchLive: true, keywords: ["quiero"], dmMessage: "Hola {username}" });
    expect(parsed.success).toBe(true);
    const missing = createAutomationSchema.safeParse({ name: "Sin post", keywords: ["quiero"], dmMessage: "Hola" });
    expect(missing.success).toBe(false);
  });
});
