import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Regression tests for the 2026-11-12 security audit (run-1):
// owner demotion via invite, cross-workspace diagnostics, cron "Bearer undefined",
// and OAuth state not bound to the initiating browser.

const h = vi.hoisted(() => ({
  sessionUserId: "user_admin",
  context: { userId: "user_admin", workspaceId: "ws_a", role: "ADMIN" as string },
  members: [] as Array<{ id: string; workspaceId: string; userId: string; role: string }>,
  users: [] as Array<{ id: string; email: string }>,
  createdAccounts: [] as Array<Record<string, unknown>>,
  alerts: [] as Array<Record<string, unknown>>,
  eventWheres: [] as unknown[],
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: h.sessionUserId } })),
  getCurrentWorkspaceId: vi.fn(async () => h.context.workspaceId),
  getCurrentUserId: vi.fn(async () => h.context.userId),
}));
vi.mock("@/lib/workspace-access", async (orig) => {
  const real = await orig<typeof import("@/lib/workspace-access")>();
  return { ...real, getCurrentWorkspaceContext: vi.fn(async () => ({ ...h.context, workspace: { id: h.context.workspaceId } })) };
});
vi.mock("@/lib/db/client", () => ({
  prisma: {
    user: { findUnique: vi.fn(async ({ where }: { where: { email: string } }) => h.users.find((u) => u.email === where.email) ?? null) },
    workspaceMember: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_userId: { workspaceId: string; userId: string } } }) =>
        h.members.find((m) => m.workspaceId === where.workspaceId_userId.workspaceId && m.userId === where.workspaceId_userId.userId) ?? null),
      findFirst: vi.fn(async ({ where }: { where: { workspaceId: string; userId: string } }) =>
        h.members.find((m) => m.workspaceId === where.workspaceId && m.userId === where.userId) ?? null),
      create: vi.fn(async ({ data }: { data: { workspaceId: string; userId: string; role: string } }) => {
        const row = { id: `m_${h.members.length}`, ...data };
        h.members.push(row);
        return row;
      }),
      upsert: vi.fn(async () => { throw new Error("invite must not upsert memberships"); }),
      findMany: vi.fn(async () => []),
    },
    workspaceInvitation: { upsert: vi.fn(async ({ create }: { create: unknown }) => create), findMany: vi.fn(async () => []) },
    instagramAccount: {
      findMany: vi.fn(async () => [{ instagramId: "ig_own" }]),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.createdAccounts.push(data); return data; }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    webhookEvent: { findMany: vi.fn(async () => []) },
    dmLog: { findMany: vi.fn(async () => []) },
    operationalEvent: {
      findMany: vi.fn(async ({ where }: { where: unknown }) => { h.eventWheres.push(where); return []; }),
      create: vi.fn(async () => ({})),
    },
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 }) }),
  getRedisConnection: () => ({
    lrange: async () => h.alerts.map((a) => JSON.stringify(a)),
    get: async () => JSON.stringify({ status: "running", worker: "dm", pid: 4242, hostname: "worker-host", checkedAt: new Date().toISOString() }),
  }),
}));
vi.mock("@/lib/meta/client", () => ({
  getLongLivedToken: vi.fn(async () => ({ accessToken: "long_token", expiresIn: 3600 })),
  getUserInfo: vi.fn(async () => ({ user_id: "ig_new", id: "ig_new", username: "new_ig" })),
  subscribeInstagramAccountToWebhooks: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/lib/meta/oauth", async (orig) => {
  const real = await orig<typeof import("@/lib/meta/oauth")>();
  return { ...real, exchangeCodeForToken: vi.fn(async () => ({ accessToken: "short", userId: "ig_new" })) };
});

import { POST as invite } from "../app/api/workspace/members/route";
import { GET as diagnostics } from "../app/api/admin/diagnostics/route";
import { GET as connect } from "../app/api/instagram/connect/route";
import { GET as callback } from "../app/api/instagram/callback/route";
import { isAuthorizedCron } from "../lib/cron-auth";
import { OAUTH_NONCE_COOKIE, createOAuthState } from "../lib/meta/oauth";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXTAUTH_SECRET", "dummy-secret-with-enough-length");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.test");
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  vi.stubEnv("INSTAGRAM_APP_ID", "dummy-app");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "dummy-app-secret");
  h.sessionUserId = "user_admin";
  h.context = { userId: "user_admin", workspaceId: "ws_a", role: "ADMIN" };
  h.users = [{ id: "user_owner", email: "owner@example.test" }, { id: "user_new", email: "new@example.test" }];
  h.members = [
    { id: "m_owner", workspaceId: "ws_a", userId: "user_owner", role: "OWNER" },
    { id: "m_admin", workspaceId: "ws_a", userId: "user_admin", role: "ADMIN" },
  ];
  h.createdAccounts = [];
  h.alerts = [];
  h.eventWheres = [];
});

const inviteRequest = (body: unknown) =>
  new NextRequest("https://app.example.test/api/workspace/members", { method: "POST", body: JSON.stringify(body) });

describe("invite never changes an existing membership", () => {
  it("refuses to demote the OWNER through the invite endpoint", async () => {
    const response = await invite(inviteRequest({ email: "owner@example.test", role: "MEMBER" }));
    expect(response.status).toBe(409);
    expect(h.members.find((m) => m.userId === "user_owner")?.role).toBe("OWNER");
  });

  it("still adds a registered user who is not yet a member", async () => {
    const response = await invite(inviteRequest({ email: "new@example.test", role: "MEMBER" }));
    expect(response.status).toBe(200);
    expect(h.members.find((m) => m.userId === "user_new")).toMatchObject({ workspaceId: "ws_a", role: "MEMBER" });
  });
});

describe("diagnostics stays inside the workspace", () => {
  it("drops other workspaces' worker alerts, unattributed events and worker host details", async () => {
    h.alerts = [
      { level: "error", message: "own failure", jobId: "j1", instagramAccountId: "ig_own", createdAt: "t" },
      { level: "error", message: "other tenant failure", jobId: "j2", instagramAccountId: "ig_other", commentId: "c2", createdAt: "t" },
    ];
    const body = await (await diagnostics()).json();
    expect(body.data.workerAlerts).toEqual([{ level: "error", message: "own failure", jobId: "j1", createdAt: "t" }]);
    expect(JSON.stringify(body)).not.toContain("ig_other");
    expect(body.data.workerHealth.heartbeat).not.toHaveProperty("pid");
    expect(body.data.workerHealth.heartbeat).not.toHaveProperty("hostname");
    expect(h.eventWheres).toContainEqual({ workspaceId: "ws_a" });
    expect(JSON.stringify(h.eventWheres)).not.toContain("null");
  });
});

describe("cron authorization fails closed", () => {
  it("rejects everything when no secret is configured", () => {
    vi.stubEnv("NEXTAUTH_SECRET", "");
    vi.stubEnv("CRON_SECRET", "");
    expect(isAuthorizedCron("Bearer undefined")).toBe(false);
    expect(isAuthorizedCron("Bearer ")).toBe(false);
    expect(isAuthorizedCron(null)).toBe(false);
  });

  it("accepts only the configured secret", () => {
    vi.stubEnv("CRON_SECRET", "dummy-cron-secret-0123456789");
    expect(isAuthorizedCron("Bearer dummy-cron-secret-0123456789")).toBe(true);
    expect(isAuthorizedCron("Bearer undefined")).toBe(false);
    expect(isAuthorizedCron("Bearer dummy-cron-secret-012345678")).toBe(false);
  });
});

describe("Instagram OAuth state is bound to the initiating browser and user", () => {
  const callbackRequest = (state: string, nonce?: string) =>
    new NextRequest(`https://app.example.test/api/instagram/callback?code=CODE&state=${encodeURIComponent(state)}`, {
      headers: nonce ? { cookie: `${OAUTH_NONCE_COOKIE}=${nonce}` } : {},
    });

  it("connect sets an httpOnly nonce cookie matching the signed state", async () => {
    const response = await connect();
    const cookie = response.cookies.get(OAUTH_NONCE_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    const state = new URL(response.headers.get("location")!).searchParams.get("state")!;
    const payload = JSON.parse(Buffer.from(state.split(".")[0], "base64url").toString());
    expect(payload).toMatchObject({ workspaceId: "ws_a", userId: "user_admin", nonce: cookie?.value });
  });

  it("rejects a state minted for another user, even if the victim is an admin of that workspace", async () => {
    h.sessionUserId = "user_victim";
    h.members.push({ id: "m_victim", workspaceId: "ws_a", userId: "user_victim", role: "ADMIN" });
    const nonce = "attacker-nonce-0123456789";
    const response = await callback(callbackRequest(createOAuthState("ws_a", "user_admin", nonce), nonce));
    expect(response.headers.get("location")).toBe("https://app.example.test/settings?instagram=invalid");
    expect(h.createdAccounts).toHaveLength(0);
  });

  it("rejects the right user when the nonce cookie is missing or different", async () => {
    const state = createOAuthState("ws_a", "user_admin", "nonce-0123456789abcdef");
    for (const cookieNonce of [undefined, "other-nonce-0123456789ab"]) {
      const response = await callback(callbackRequest(state, cookieNonce));
      expect(response.headers.get("location")).toBe("https://app.example.test/settings?instagram=invalid");
    }
    expect(h.createdAccounts).toHaveLength(0);
  });

  it("connects when the same browser and user finish the flow, then clears the nonce", async () => {
    const nonce = "nonce-0123456789abcdef";
    const response = await callback(callbackRequest(createOAuthState("ws_a", "user_admin", nonce), nonce));
    expect(response.headers.get("location")).toBe("https://app.example.test/dashboard?connected=true");
    expect(h.createdAccounts[0]).toMatchObject({ workspaceId: "ws_a", instagramId: "ig_new" });
    expect(response.cookies.get(OAUTH_NONCE_COOKIE)?.value).toBe("");
  });
});
